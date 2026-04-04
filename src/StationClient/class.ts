import { encode, decode } from '@msgpack/msgpack'
import type {
  StationClientEventMap,
  StationClientEventListenerFor,
  StationClientLocalMessageShape,
} from '../.types/index.js'

export class StationClient<T extends Record<string, unknown>> {
  private readonly eventTarget = new EventTarget()
  private readonly lockName: string
  private readonly channelName: string
  private readonly webSocketUrl: string
  private readonly onlineHandler = () => {
    void this.opportunisticConnect()
  }
  private broadcastChannel: BroadcastChannel | null = null
  private webSocket: WebSocket | null = null
  private isLeader: boolean = false
  private isClosed: boolean = false
  private isConnecting: boolean = false
  private readonly outboundQueue: T[] = []

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

      if (envelope.kind === 'relay')
        this.eventTarget.dispatchEvent(
          new CustomEvent('message', { detail: envelope.message })
        )
      if (!this.isLeader) return

      this.sendToStation(envelope.message)
    }

    if (this.webSocketUrl && navigator.onLine) void this.opportunisticConnect()
    if (this.webSocketUrl) {
      self.addEventListener('online', this.onlineHandler)
    }
  }
  /**main methods*/
  relay(message: T) {
    this.broadcastChannel?.postMessage({ kind: 'relay', message })
    this.sendToStation(message)
  }

  transact(message: T) {
    if (this.isLeader) {
      this.sendToStation(message)
      return
    }

    this.broadcastChannel?.postMessage({ kind: 'transact', message })
  }

  close(): void {
    this.isClosed = true
    self.removeEventListener('online', this.onlineHandler)

    try {
      this.broadcastChannel?.close()
    } catch {}
    try {
      this.webSocket?.close(1000, 'closed')
    } catch {}

    this.webSocket = null
    this.isLeader = false
  }

  /**listeners*/

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

  private sendToStation(message: T) {
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
