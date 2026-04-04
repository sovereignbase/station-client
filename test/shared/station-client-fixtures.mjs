import { decode, encode } from '@msgpack/msgpack'

export class MockBroadcastChannel {
  static channels = new Map()

  static reset() {
    this.channels.clear()
  }

  constructor(name) {
    this.name = name
    this.closed = false
    this.onmessage = null

    const peers = MockBroadcastChannel.channels.get(name) ?? new Set()
    peers.add(this)
    MockBroadcastChannel.channels.set(name, peers)
  }

  postMessage(message) {
    if (this.closed) {
      throw new DOMException('BroadcastChannel is closed.', 'InvalidStateError')
    }

    const peers = MockBroadcastChannel.channels.get(this.name)
    if (!peers) return

    queueMicrotask(() => {
      for (const peer of peers) {
        if (peer === this || peer.closed) continue
        peer.onmessage?.({ data: structuredClone(message) })
      }
    })
  }

  close() {
    if (this.closed) return

    this.closed = true
    const peers = MockBroadcastChannel.channels.get(this.name)
    if (!peers) return

    peers.delete(this)
    if (peers.size === 0) MockBroadcastChannel.channels.delete(this.name)
  }
}

export class MockLockManager {
  #held = new Map()

  async request(name, options, callback) {
    if (options?.ifAvailable === true && this.#held.has(name)) {
      return callback(null)
    }

    const lockHandle = { name }
    this.#held.set(name, lockHandle)

    try {
      return await callback(lockHandle)
    } finally {
      if (this.#held.get(name) === lockHandle) this.#held.delete(name)
    }
  }
}

export class MockWebSocket extends EventTarget {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3
  static behaviors = new Map()
  static sockets = new Map()

  static reset() {
    this.behaviors.clear()
    for (const sockets of this.sockets.values()) {
      for (const socket of sockets) {
        try {
          socket.close(1000, 'reset')
        } catch {}
      }
    }
    this.sockets.clear()
  }

  constructor(url) {
    super()

    this.url = url
    this.binaryType = 'blob'
    this.readyState = MockWebSocket.CONNECTING
    this.onopen = null
    this.onmessage = null
    this.onclose = null
    this.sent = []

    const behavior = MockWebSocket.behaviors.get(url)
    if (behavior?.throwOnConstruct) {
      throw behavior.throwOnConstruct === true
        ? new Error(`MockWebSocket failed for ${url}`)
        : behavior.throwOnConstruct
    }

    const sockets = MockWebSocket.sockets.get(url) ?? new Set()
    sockets.add(this)
    MockWebSocket.sockets.set(url, sockets)

    queueMicrotask(() => {
      if (behavior?.autoOpen === false) return
      if (this.readyState !== MockWebSocket.CONNECTING) return

      this.readyState = MockWebSocket.OPEN
      this.onopen?.(new Event('open'))
      this.dispatchEvent(new Event('open'))
      behavior?.onOpen?.(this)
    })
  }

  send(data) {
    if (this.readyState !== MockWebSocket.OPEN) {
      throw new Error('MockWebSocket is not open.')
    }

    const behavior = MockWebSocket.behaviors.get(this.url)
    const failure = behavior?.failSend
    if (typeof failure === 'function') failure(this, data)
    else if (failure) throw new Error('MockWebSocket send failed.')

    this.sent.push(data)
    behavior?.onSend?.(this, data)
  }

  close(_code = 1000, _reason = '') {
    if (this.readyState === MockWebSocket.CLOSED) return

    this.readyState = MockWebSocket.CLOSED
    const sockets = MockWebSocket.sockets.get(this.url)
    sockets?.delete(this)
    if (sockets?.size === 0) MockWebSocket.sockets.delete(this.url)

    const behavior = MockWebSocket.behaviors.get(this.url)
    const event = new Event('close')
    this.onclose?.(event)
    this.dispatchEvent(event)
    behavior?.onClose?.(this)
  }

  receive(message) {
    const event = { data: message }
    this.onmessage?.(event)
  }
}

export function installMockBaseStation(url, options = {}) {
  const state = {
    currentConnections: 0,
    totalConnections: 0,
    messages: [],
    requests: [],
  }

  MockWebSocket.behaviors.set(url, {
    onOpen() {
      state.currentConnections += 1
      state.totalConnections += 1
    },
    onClose() {
      state.currentConnections -= 1
    },
    onSend(socket, data) {
      const message = decode(new Uint8Array(data))

      if (
        Array.isArray(message) &&
        message[0] === 'station-client-request' &&
        typeof message[1] === 'string'
      ) {
        state.requests.push(message)

        const response = options.onRequest
          ? options.onRequest(message[2], message[1], socket)
          : [
              'station-client-response',
              message[1],
              { ok: true, echo: message[2] },
            ]

        if (response) {
          queueMicrotask(() => {
            socket.receive(encode(response))
          })
        }
        return
      }

      state.messages.push(message)
      options.onMessage?.(message, socket)
    },
  })

  return {
    state,
    broadcast(message) {
      const sockets = MockWebSocket.sockets.get(url)
      if (!sockets) return

      for (const socket of sockets) {
        if (socket.readyState !== MockWebSocket.OPEN) continue
        socket.receive(encode(message))
      }
    },
  }
}

export function installBrowserLikeRuntime(options = {}) {
  MockBroadcastChannel.reset()
  MockWebSocket.reset()

  const restores = []
  const globalEventTarget = new EventTarget()

  const define = (name, value) => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, name)
    restores.push(() => {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else delete globalThis[name]
    })
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value,
    })
  }

  const navigatorValue = {
    userAgent: 'station-client-test',
    onLine: options.onLine ?? true,
    locks: Object.hasOwn(options, 'locks')
      ? options.locks
      : new MockLockManager(),
  }

  define('navigator', navigatorValue)
  define('self', globalThis)
  define(
    'addEventListener',
    globalEventTarget.addEventListener.bind(globalEventTarget)
  )
  define(
    'removeEventListener',
    globalEventTarget.removeEventListener.bind(globalEventTarget)
  )
  define(
    'dispatchEvent',
    globalEventTarget.dispatchEvent.bind(globalEventTarget)
  )
  define(
    'BroadcastChannel',
    options.BroadcastChannelImpl ?? MockBroadcastChannel
  )
  define('WebSocket', options.WebSocketImpl ?? MockWebSocket)

  return {
    navigator: navigatorValue,
    restore() {
      for (let index = restores.length - 1; index >= 0; index -= 1) {
        restores[index]()
      }
      MockBroadcastChannel.reset()
      MockWebSocket.reset()
    },
  }
}

export async function waitFor(assertion, options = {}) {
  const timeoutMs = options.timeoutMs ?? 1_000
  const intervalMs = options.intervalMs ?? 10
  const startedAt = Date.now()

  while (Date.now() - startedAt < timeoutMs) {
    const value = await assertion()
    if (value) return value
    await sleep(intervalMs)
  }

  throw new Error(`Timed out after ${timeoutMs}ms.`)
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
