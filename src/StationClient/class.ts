import { encode, decode } from '@msgpack/msgpack'
import type {
  StationClientEventMap,
  StationClientEventListenerFor,
  StationClientLocalMessageShape,
  StationClientPendingTransact,
  StationClientPendingTransactTarget,
  StationClientRemoteMessageShape,
  StationClientTransactOptions,
} from '../.types/index.js'

/**
 * Represents a base station client that coordinates local tab messaging and an opportunistic base station transport.
 *
 * @template T The application message shape.
 */
export class StationClient<T extends Record<string, unknown>> {
  private readonly eventTarget = new EventTarget()
  private readonly lockName: string
  private readonly channelName: string
  private readonly webSocketUrl: string
  private readonly instanceId = self.crypto.randomUUID()
  private readonly onlineHandler = () => {
    void this.opportunisticConnect()
  }
  private broadcastChannel: BroadcastChannel | null = null
  private webSocket: WebSocket | null = null
  private isLeader: boolean = false
  private isClosed: boolean = false
  private isConnecting: boolean = false
  private readonly outboundQueue: StationClientRemoteMessageShape<T>[] = []
  private readonly pendingTransacts = new Map<
    string,
    StationClientPendingTransact<T>
  >()
  private readonly pendingTransactTargets = new Map<
    string,
    StationClientPendingTransactTarget
  >()

  /**
   * Initializes a new {@link StationClient} instance.
   *
   * @param webSocketUrl The base station WebSocket URL. When omitted, the instance operates in local-only mode.
   */
  constructor(webSocketUrl: string = '') {
    this.webSocketUrl = webSocketUrl
    this.channelName = `origin-channel-lock::${this.webSocketUrl}`
    this.lockName = `origin-channel-lock::${this.webSocketUrl}`

    this.broadcastChannel = new BroadcastChannel(this.channelName)
    this.broadcastChannel.onmessage = (
      event: MessageEvent<StationClientLocalMessageShape<T>>
    ) => {
      const envelope = event.data
      if (!envelope) return

      if (envelope.kind === 'relay') {
        this.eventTarget.dispatchEvent(
          new CustomEvent('message', { detail: envelope.message })
        )
        if (!this.isLeader) return

        this.sendToStation(envelope.message)
        return
      }

      if (envelope.kind === 'transact-response') {
        if (envelope.target !== this.instanceId) return

        const pending = this.pendingTransacts.get(envelope.id)
        if (!pending) return

        this.pendingTransacts.delete(envelope.id)
        pending.cleanup()
        pending.resolve(envelope.message)
        return
      }

      if (envelope.kind === 'transact-abort') {
        if (!this.isLeader) return

        const pendingTarget = this.pendingTransactTargets.get(envelope.id)
        if (pendingTarget) clearTimeout(pendingTarget.timeoutId)
        this.pendingTransactTargets.delete(envelope.id)
        return
      }

      if (!this.isLeader) return

      if (
        !this.webSocketUrl ||
        self.navigator.onLine !== true ||
        !this.webSocket ||
        this.webSocket.readyState !== WebSocket.OPEN
      ) {
        this.broadcastChannel?.postMessage({
          kind: 'transact-response',
          id: envelope.id,
          target: envelope.source,
          message: false,
        })
        return
      }

      const pendingTarget = this.pendingTransactTargets.get(envelope.id)
      if (pendingTarget) clearTimeout(pendingTarget.timeoutId)

      this.pendingTransactTargets.set(envelope.id, {
        target: envelope.source,
        timeoutId: setTimeout(() => {
          this.pendingTransactTargets.delete(envelope.id)
        }, envelope.ttlMs ?? 30_000),
      })
      this.sendToStation([
        'station-client-request',
        envelope.id,
        envelope.message,
      ])
    }

    if (this.webSocketUrl && navigator.onLine) void this.opportunisticConnect()
    if (this.webSocketUrl) {
      self.addEventListener('online', this.onlineHandler)
    }
  }
  /**main methods*/

  /**
   * Broadcasts a message to other same-origin contexts and opportunistically forwards it to the base station.
   *
   * @param message The message to broadcast.
   */
  relay(message: T) {
    if (this.isClosed) return

    this.broadcastChannel?.postMessage({ kind: 'relay', message })
    this.sendToStation(message)
  }

  /**
   * Sends a request to the base station and resolves with the corresponding response message.
   *
   * @param message The message to send.
   * @param options Options that control cancellation and stale follower cleanup.
   * @returns A promise that resolves with the response message, or `false` when the request cannot be issued.
   */
  transact(
    message: T,
    options: StationClientTransactOptions = {}
  ): Promise<T | false> {
    if (this.isClosed) return Promise.resolve(false)

    const id = self.crypto.randomUUID()
    const { signal, ttlMs } = options

    return new Promise<T | false>((resolve, reject) => {
      const abortReason = () =>
        signal?.reason ??
        new DOMException('The operation was aborted.', 'AbortError')

      if (signal?.aborted) {
        reject(abortReason())
        return
      }

      if (!this.webSocketUrl || self.navigator.onLine !== true) {
        resolve(false)
        return
      }

      if (
        this.isLeader &&
        (!this.webSocket || this.webSocket.readyState !== WebSocket.OPEN)
      ) {
        resolve(false)
        return
      }

      const handleAbort = () => {
        this.pendingTransacts.delete(id)
        const pendingTarget = this.pendingTransactTargets.get(id)
        if (pendingTarget) clearTimeout(pendingTarget.timeoutId)
        this.pendingTransactTargets.delete(id)
        signal?.removeEventListener('abort', handleAbort)

        if (!this.isLeader) {
          this.broadcastChannel?.postMessage({ kind: 'transact-abort', id })
        }

        reject(abortReason())
      }

      this.pendingTransacts.set(id, {
        resolve,
        reject,
        cleanup: () => {
          signal?.removeEventListener('abort', handleAbort)
        },
      })
      signal?.addEventListener('abort', handleAbort, { once: true })

      if (this.isLeader) {
        this.sendToStation(['station-client-request', id, message])
        return
      }

      this.broadcastChannel?.postMessage({
        kind: 'transact',
        id,
        source: this.instanceId,
        ttlMs,
        message,
      })
    })
  }

  /**
   * Closes the client and releases its local and remote resources.
   */
  close(): void {
    const wasLeader = this.isLeader
    const broadcastChannel = this.broadcastChannel
    this.isClosed = true
    self.removeEventListener('online', this.onlineHandler)

    if (!wasLeader) {
      for (const id of this.pendingTransacts.keys()) {
        try {
          broadcastChannel?.postMessage({ kind: 'transact-abort', id })
        } catch {}
      }
    }

    try {
      broadcastChannel?.close()
    } catch {}
    try {
      this.webSocket?.close(1000, 'closed')
    } catch {}

    this.broadcastChannel = null
    this.webSocket = null
    this.isLeader = false
    this.outboundQueue.length = 0
    for (const pending of this.pendingTransacts.values()) {
      pending.cleanup()
      pending.reject(new Error('Station client closed'))
    }
    this.pendingTransacts.clear()
    for (const pendingTarget of this.pendingTransactTargets.values()) {
      clearTimeout(pendingTarget.timeoutId)
    }
    this.pendingTransactTargets.clear()
  }

  /**listeners*/

  /**
   * Appends an event listener for events whose type attribute value is `type`.
   *
   * @param type The event type to listen for.
   * @param listener The callback that receives the event.
   * @param options An options object that specifies characteristics about the event listener.
   */
  addEventListener<K extends keyof StationClientEventMap<T>>(
    type: K,
    listener: StationClientEventListenerFor<T, K> | null,
    options?: boolean | AddEventListenerOptions
  ): void {
    this.eventTarget.addEventListener(
      type,
      listener as EventListenerOrEventListenerObject | null,
      options
    )
  }

  /**
   * Removes an event listener previously registered with {@link addEventListener}.
   *
   * @param type The event type to remove.
   * @param listener The callback to remove.
   * @param options An options object that specifies characteristics about the event listener.
   */
  removeEventListener<K extends keyof StationClientEventMap<T>>(
    type: K,
    listener: StationClientEventListenerFor<T, K> | null,
    options?: boolean | EventListenerOptions
  ): void {
    this.eventTarget.removeEventListener(
      type,
      listener as EventListenerOrEventListenerObject | null,
      options
    )
  }

  /**helpers*/

  private sendToStation(message: StationClientRemoteMessageShape<T>) {
    if (!this.isLeader || !this.webSocketUrl) return

    if (!this.webSocket || this.webSocket.readyState !== WebSocket.OPEN) {
      if (self.navigator.onLine) {
        if (this.outboundQueue.length >= 64) this.outboundQueue.shift()
        this.outboundQueue.push(message)
      }
      return
    }

    try {
      this.webSocket.send(encode(message))
    } catch {}
  }

  private flushOutboundQueue() {
    if (!this.webSocket || this.webSocket.readyState !== WebSocket.OPEN) return

    while (this.outboundQueue.length > 0) {
      const message = this.outboundQueue.shift()
      if (!message) continue

      try {
        this.webSocket.send(encode(message))
      } catch {
        this.outboundQueue.unshift(message)
        return
      }
    }
  }

  private async opportunisticConnect() {
    if (this.isClosed || this.isConnecting || !this.webSocketUrl) return
    if (!self.navigator.locks) return

    this.isConnecting = true

    try {
      while (!this.isClosed) {
        if (self.navigator.onLine !== true) return

        await self.navigator.locks.request(
          this.lockName,
          { ifAvailable: true },
          async (lockHandle) => {
            if (!lockHandle || this.isClosed) return
            this.isLeader = true

            let socket: WebSocket

            try {
              socket = new WebSocket(this.webSocketUrl)
            } catch {
              this.isLeader = false
              this.webSocket = null
              return
            }

            socket.binaryType = 'arraybuffer'
            this.webSocket = socket

            socket.onopen = () => {
              this.flushOutboundQueue()
            }

            socket.onmessage = (event: MessageEvent<ArrayBuffer>) => {
              const message = decode(event.data)
              if (!message) return

              if (
                Array.isArray(message) &&
                message[0] === 'station-client-response' &&
                typeof message[1] === 'string'
              ) {
                const id = message[1]
                const pendingTarget = this.pendingTransactTargets.get(id)
                if (pendingTarget) {
                  clearTimeout(pendingTarget.timeoutId)
                  this.pendingTransactTargets.delete(id)

                  this.broadcastChannel?.postMessage({
                    kind: 'transact-response',
                    id,
                    target: pendingTarget.target,
                    message: message[2] as T,
                  })
                  return
                }

                const pending = this.pendingTransacts.get(id)
                if (!pending) return

                this.pendingTransacts.delete(id)
                pending.cleanup()
                pending.resolve(message[2] as T)
                return
              }

              this.eventTarget.dispatchEvent(
                new CustomEvent('message', { detail: message })
              )

              this.broadcastChannel?.postMessage({
                kind: 'relay',
                message: message as T,
              })
            }

            socket.onclose = () => {
              if (this.webSocket === socket) this.webSocket = null
              this.isLeader = false
            }

            await new Promise<void>((resolve) => {
              socket.addEventListener('close', () => resolve(), { once: true })
            })

            this.isLeader = false
            if (this.webSocket === socket) this.webSocket = null
          }
        )

        if (this.isClosed || self.navigator.onLine !== true) return
        await new Promise<void>((resolve) => setTimeout(resolve, 10_000))
      }
    } finally {
      this.isConnecting = false
    }
  }
}
