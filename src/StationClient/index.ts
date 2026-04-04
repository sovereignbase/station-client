import { encode, decode } from '@msgpack/msgpack'
import type {
  StationClientEventMap,
  StationClientEventListenerFor,
} from '../.types/index.js'

export class StationClient<T extends Record<string, unknown>> {
  private readonly eventTarget = new EventTarget()
  private readonly lockName: string
  private readonly channelName: string
  private readonly webSocketUrl: string
  private broadcastChannel: BroadcastChannel | null = null
  private webSocket: WebSocket | null = null
  private isLeader: boolean = false

  constructor(webSocketUrl: string = '') {
    this.webSocketUrl = webSocketUrl
    this.channelName = `origin-channel-lock::${this.webSocketUrl}`
    this.lockName = `origin-channel-lock::${this.webSocketUrl}`

    this.broadcastChannel = new BroadcastChannel(this.channelName)
    this.broadcastChannel.onmessage = (event: MessageEvent<T>) => {
      const message = event.data
      if (!message) return
      this.eventTarget.dispatchEvent(
        new CustomEvent('message', { detail: message })
      )

      if (!this.isLeader) return
      if (!this.webSocket || this.webSocket.readyState !== WebSocket.OPEN)
        return

      this.webSocket.send(encode(message))
    }

    /** if navigator online, and on "online" event,  */
    if (navigator.onLine) void this.opportunisticConnect()

    self.addEventListener('online', () => {
      void this.opportunisticConnect()
    })
  }

  close(): void {
    try {
      this.broadcastChannel?.close()
    } catch {}
    try {
      this.webSocket?.close(1000, 'closed')
    } catch {}
    this.webSocket = null
    this.isLeader = false
  }

  /**
   * Registers an event listener.
   *
   * @param type - The event type to listen for.
   * @param listener - The listener to register.
   * @param options - Listener registration options.
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
   * Removes an event listener.
   *
   * @param type - The event type to stop listening for.
   * @param listener - The listener to remove.
   * @param options - Listener removal options.
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

  /**Helper*/
  private async opportunisticConnect() {
    while (true) {
      await self.navigator.locks.request(
        this.lockName,
        { ifAvailable: true },
        async (lockHandle) => {
          if (!lockHandle) return
          this.isLeader = true

          try {
            this.webSocket = new WebSocket(this.webSocketUrl)
          } catch {}

          if (!this.webSocket || this.webSocket.readyState !== WebSocket.OPEN)
            return

          this.webSocket.onmessage = async (
            event: MessageEvent<ArrayBuffer>
          ) => {
            void (async () => {
              const message = decode(event.data)
              if (!message) return
              // this.eventlistheners
              this.broadcastChannel?.postMessage(message as T)
            })
          }

          this.webSocket.onclose = () => {
            if (this.webSocket === this.webSocket) this.webSocket = null
          }

          await new Promise<void>((resolve) => {
            this.webSocket?.addEventListener('close', () => resolve(), {
              once: true,
            })
          })

          this.isLeader = false
          if (this.webSocket === this.webSocket) this.webSocket = null
        }
      )

      await new Promise<void>((resolve) => setTimeout(resolve, 500))
    }
  }
  relay(message: T) {}
  backup(snapshot: T) {
    this.webSocket
  }
}
