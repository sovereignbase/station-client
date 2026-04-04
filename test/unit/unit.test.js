import assert from 'node:assert/strict'
import test from 'node:test'
import { decode, encode } from '@msgpack/msgpack'
import { StationClient } from '../../dist/index.js'
import {
  MockWebSocket,
  installBrowserLikeRuntime,
  installMockBaseStation,
  waitFor,
} from '../shared/station-client-fixtures.mjs'

test('unit: relay synchronizes to sibling tabs without echoing to sender', async () => {
  const runtime = installBrowserLikeRuntime({ locks: undefined })
  const sender = new StationClient()
  const receiver = new StationClient()
  const senderMessages = []
  const receiverMessages = []

  try {
    sender.addEventListener('message', (event) => {
      senderMessages.push(event.detail)
    })
    receiver.addEventListener('message', (event) => {
      receiverMessages.push(event.detail)
    })

    sender.relay({ type: 'relay', value: 'hello' })

    await waitFor(() => receiverMessages.length === 1)
    assert.deepEqual(senderMessages, [])
    assert.deepEqual(receiverMessages, [{ type: 'relay', value: 'hello' }])
  } finally {
    sender.close()
    receiver.close()
    runtime.restore()
  }
})

test('unit: transact guards return false and abort rejects', async () => {
  const runtime = installBrowserLikeRuntime({ locks: undefined })

  try {
    const localOnlyClient = new StationClient()
    assert.equal(await localOnlyClient.transact({ type: 'ping' }), false)

    localOnlyClient.close()
    assert.equal(await localOnlyClient.transact({ type: 'after-close' }), false)

    runtime.navigator.onLine = false
    const offlineClient = new StationClient('ws://mock/offline')
    assert.equal(await offlineClient.transact({ type: 'offline' }), false)
    offlineClient.close()

    runtime.navigator.onLine = true
    const leaderClient = new StationClient('ws://mock/not-open')
    leaderClient.isLeader = true
    leaderClient.webSocket = { readyState: MockWebSocket.CONNECTING }
    assert.equal(await leaderClient.transact({ type: 'not-open' }), false)
    leaderClient.close()

    const abortedSignal = AbortSignal.abort()
    const abortedClient = new StationClient('ws://mock/aborted')
    await assert.rejects(
      abortedClient.transact({ type: 'aborted' }, { signal: abortedSignal }),
      /AbortError/
    )
    abortedClient.close()

    const fallbackAbortClient = new StationClient('ws://mock/fallback-abort')
    await assert.rejects(
      fallbackAbortClient.transact(
        { type: 'fallback-abort' },
        {
          signal: {
            aborted: true,
            reason: undefined,
            addEventListener() {},
            removeEventListener() {},
          },
        }
      ),
      /AbortError/
    )
    fallbackAbortClient.close()

    const followerClient = new StationClient('ws://mock/abort')
    const controller = new AbortController()
    const pending = followerClient.transact(
      { type: 'abort-later' },
      { signal: controller.signal }
    )
    controller.abort()

    await assert.rejects(pending, /AbortError/)
    assert.equal(followerClient.pendingTransacts.size, 0)
    assert.equal(followerClient.pendingTransactTargets.size, 0)
    followerClient.close()
  } finally {
    runtime.restore()
  }
})

test('unit: close rejects pending transact and broadcasts abort before closing the channel', async () => {
  const runtime = installBrowserLikeRuntime()
  const leader = new StationClient('ws://mock/close')
  const follower = new StationClient('ws://mock/close')
  let rejectedReason = null

  try {
    leader.isLeader = true
    leader.pendingTransactTargets.set('request-1', {
      target: 'follower',
      timeoutId: setTimeout(() => {}, 1_000),
    })

    follower.pendingTransacts.set('request-1', {
      resolve() {},
      reject(reason) {
        rejectedReason = reason
      },
      cleanup() {},
    })

    follower.close()

    await waitFor(() => !leader.pendingTransactTargets.has('request-1'))
    assert.match(String(rejectedReason), /Station client closed/)
  } finally {
    leader.close()
    follower.close()
    runtime.restore()
  }
})

test('unit: close clears pending transact target timeouts', () => {
  const runtime = installBrowserLikeRuntime()
  const client = new StationClient('ws://mock/close-timeout')

  try {
    client.pendingTransactTargets.set('request-1', {
      target: 'peer',
      timeoutId: setTimeout(() => {}, 1_000),
    })

    client.close()
    assert.equal(client.pendingTransactTargets.size, 0)
  } finally {
    client.close()
    runtime.restore()
  }
})

test('unit: sendToStation queues, caps, and flushes outbound messages', async () => {
  const runtime = installBrowserLikeRuntime({ locks: undefined })
  const client = new StationClient('ws://mock/queue')

  try {
    client.isLeader = true
    client.webSocket = { readyState: MockWebSocket.CONNECTING }

    for (let index = 0; index < 65; index += 1) {
      client.sendToStation({ index })
    }

    assert.equal(client.outboundQueue.length, 64)
    assert.deepEqual(client.outboundQueue[0], { index: 1 })

    runtime.navigator.onLine = false
    client.sendToStation({ index: 99 })
    assert.equal(client.outboundQueue.length, 64)

    runtime.navigator.onLine = true

    let failNextFlush = true
    const sent = []
    client.webSocket = {
      readyState: MockWebSocket.OPEN,
      send(data) {
        if (failNextFlush) {
          failNextFlush = false
          throw new Error('flush failed')
        }

        sent.push(decode(new Uint8Array(data)))
      },
    }

    client.flushOutboundQueue()
    assert.equal(client.outboundQueue.length, 64)

    client.flushOutboundQueue()
    assert.equal(client.outboundQueue.length, 0)
    assert.equal(sent.length, 64)

    client.webSocket = {
      readyState: MockWebSocket.OPEN,
      send() {
        throw new Error('ignored send failure')
      },
    }

    assert.doesNotThrow(() => {
      client.sendToStation({ index: 100 })
    })
  } finally {
    client.close()
    runtime.restore()
  }
})

test('unit: helper edge branches tolerate missing data and internal failures', async () => {
  const runtime = installBrowserLikeRuntime()
  const station = installMockBaseStation('ws://mock/edge-helpers', {
    onRequest() {
      return null
    },
  })

  try {
    const abortingFollower = new StationClient('ws://mock/edge-helpers')
    const abortingLeader = new StationClient('ws://mock/edge-helpers')
    await waitFor(() => station.state.currentConnections === 1)
    const connectedClient = abortingFollower.webSocket
      ? abortingFollower
      : abortingLeader

    const controller = new AbortController()
    const pending = abortingFollower.transact(
      { type: 'abort-with-target' },
      { signal: controller.signal }
    )
    const pendingId = [...abortingFollower.pendingTransacts.keys()][0]
    abortingFollower.pendingTransactTargets.set(pendingId, {
      target: 'peer',
      timeoutId: setTimeout(() => {}, 1_000),
    })
    controller.abort()
    await assert.rejects(pending, /AbortError/)

    connectedClient.webSocket.receive(encode(null))
    connectedClient.webSocket.receive(
      encode(['station-client-response', 'unknown', { type: 'unknown' }])
    )

    const originalSocket = connectedClient.webSocket
    connectedClient.webSocket = { readyState: MockWebSocket.OPEN }
    connectedClient.isClosed = true
    originalSocket.close()
    connectedClient.webSocket = originalSocket
    await waitFor(() => connectedClient.isConnecting === false)

    abortingFollower.close()
    abortingLeader.close()

    const flushClient = new StationClient('ws://mock/flush-edges')
    flushClient.flushOutboundQueue()
    flushClient.outboundQueue.push(undefined, { type: 'queued' })
    const sent = []
    flushClient.webSocket = {
      readyState: MockWebSocket.OPEN,
      send(data) {
        sent.push(decode(new Uint8Array(data)))
      },
    }
    flushClient.flushOutboundQueue()
    assert.deepEqual(sent, [{ type: 'queued' }])
    flushClient.close()

    const closingClient = new StationClient('ws://mock/close-catches')
    closingClient.isLeader = false
    closingClient.pendingTransacts.set('pending-close', {
      resolve() {},
      reject() {},
      cleanup() {},
    })
    closingClient.broadcastChannel.postMessage = () => {
      throw new Error('postMessage failed')
    }
    closingClient.broadcastChannel.close = () => {
      throw new Error('close failed')
    }
    assert.doesNotThrow(() => {
      closingClient.close()
    })

    const noUrlClient = new StationClient()
    await noUrlClient.opportunisticConnect()
    noUrlClient.close()

    const closedClient = new StationClient('ws://mock/closed-guard')
    closedClient.isClosed = true
    await closedClient.opportunisticConnect()
    closedClient.close()

    const connectingClient = new StationClient('ws://mock/connecting-guard')
    connectingClient.isConnecting = true
    await connectingClient.opportunisticConnect()
    connectingClient.close()

    runtime.navigator.onLine = false
    const offlineClient = new StationClient('ws://mock/offline-guard')
    await offlineClient.opportunisticConnect()
    offlineClient.close()
  } finally {
    runtime.restore()
  }
})

test('unit: local channel edge branches ignore irrelevant envelopes and duplicate transact ids', () => {
  const runtime = installBrowserLikeRuntime({ locks: undefined })
  const follower = new StationClient('ws://mock/channel-edges')
  const leader = new StationClient('ws://mock/channel-edges')
  const sent = []

  try {
    leader.isLeader = true
    leader.webSocket = {
      readyState: MockWebSocket.OPEN,
      send(data) {
        sent.push(decode(new Uint8Array(data)))
      },
    }

    follower.broadcastChannel.onmessage({ data: null })
    follower.broadcastChannel.onmessage({
      data: {
        kind: 'transact-response',
        id: 'wrong-target',
        target: 'someone-else',
        message: false,
      },
    })
    follower.broadcastChannel.onmessage({
      data: {
        kind: 'transact-response',
        id: 'missing-pending',
        target: follower.instanceId,
        message: false,
      },
    })
    follower.broadcastChannel.onmessage({
      data: {
        kind: 'transact-abort',
        id: 'ignored-abort',
      },
    })
    follower.broadcastChannel.onmessage({
      data: {
        kind: 'transact',
        id: 'ignored-transact',
        source: 'peer',
        message: { type: 'ignored' },
      },
    })

    leader.broadcastChannel.onmessage({
      data: {
        kind: 'transact',
        id: 'duplicate-id',
        source: 'peer',
        message: { type: 'first' },
      },
    })
    leader.broadcastChannel.onmessage({
      data: {
        kind: 'transact',
        id: 'duplicate-id',
        source: 'peer',
        message: { type: 'second' },
      },
    })

    follower.close()
    assert.doesNotThrow(() => {
      follower.relay({ type: 'after-close' })
    })

    assert.equal(sent.length, 2)
    assert.deepEqual(sent[0], [
      'station-client-request',
      'duplicate-id',
      { type: 'first' },
    ])
    assert.deepEqual(sent[1], [
      'station-client-request',
      'duplicate-id',
      { type: 'second' },
    ])
  } finally {
    leader.close()
    follower.close()
    runtime.restore()
  }
})

test('unit: opportunisticConnect returns without locks and tolerates WebSocket construction failure', async () => {
  {
    const runtime = installBrowserLikeRuntime({ locks: undefined })
    const client = new StationClient('ws://mock/no-locks')

    try {
      await client.opportunisticConnect()
      assert.equal(client.isConnecting, false)
    } finally {
      client.close()
      runtime.restore()
    }
  }

  {
    const runtime = installBrowserLikeRuntime()
    MockWebSocket.behaviors.set('ws://mock/fail-open', {
      throwOnConstruct: true,
    })
    const client = new StationClient('ws://mock/fail-open')

    try {
      assert.equal(client.isLeader, false)
      assert.equal(client.webSocket, null)
      assert.equal(client.isConnecting, true)
      client.close()
      await waitFor(() => client.isConnecting === false)
    } finally {
      client.close()
      runtime.restore()
    }
  }
})

test('unit: online event starts opportunistic base station connection and removeEventListener detaches listeners', async () => {
  const runtime = installBrowserLikeRuntime({ onLine: false })
  const station = installMockBaseStation('ws://mock/online')
  const sender = new StationClient('ws://mock/online')
  const receiver = new StationClient()
  const received = []
  const listener = (event) => {
    received.push(event.detail)
  }

  try {
    receiver.addEventListener('message', listener)
    receiver.removeEventListener('message', listener)

    runtime.navigator.onLine = true
    globalThis.dispatchEvent(new Event('online'))

    await waitFor(() => station.state.currentConnections === 1)

    sender.relay({ type: 'detached-listener' })
    await new Promise((resolve) => setTimeout(resolve, 20))

    assert.deepEqual(received, [])
  } finally {
    sender.close()
    receiver.close()
    runtime.restore()
  }
})

test('unit: leader transact resolves against the mock base station', async () => {
  const runtime = installBrowserLikeRuntime()
  const station = installMockBaseStation('ws://mock/direct')
  const client = new StationClient('ws://mock/direct')
  const controller = new AbortController()

  try {
    await waitFor(() => station.state.currentConnections === 1)

    const response = await client.transact(
      { type: 'direct' },
      { signal: controller.signal }
    )

    assert.deepEqual(response, {
      ok: true,
      echo: { type: 'direct' },
    })
    assert.equal(station.state.requests.length, 1)
    assert.equal(station.state.requests[0][0], 'station-client-request')
    assert.deepEqual(station.state.requests[0][2], { type: 'direct' })
  } finally {
    client.close()
    runtime.restore()
  }
})

test('unit: follower transact routes through the leader and relay reaches siblings and the base station', async () => {
  const runtime = installBrowserLikeRuntime()
  const station = installMockBaseStation('ws://mock/shared')
  const leader = new StationClient('ws://mock/shared')
  const follower = new StationClient('ws://mock/shared')
  const leaderMessages = []
  const followerMessages = []

  try {
    leader.addEventListener('message', (event) => {
      leaderMessages.push(event.detail)
    })
    follower.addEventListener('message', (event) => {
      followerMessages.push(event.detail)
    })

    await waitFor(() => station.state.currentConnections === 1)

    const response = await follower.transact({ type: 'question' })
    assert.deepEqual(response, {
      ok: true,
      echo: { type: 'question' },
    })

    follower.relay({ type: 'broadcast', from: 'follower' })

    await waitFor(() =>
      leaderMessages.some((message) => message.type === 'broadcast')
    )
    await waitFor(() =>
      station.state.messages.some((message) => message.type === 'broadcast')
    )

    station.broadcast({ type: 'server', from: 'base-station' })

    await waitFor(() =>
      followerMessages.some((message) => message.type === 'server')
    )

    assert.equal(station.state.currentConnections, 1)
    assert.deepEqual(station.state.messages, [
      { type: 'broadcast', from: 'follower' },
    ])
  } finally {
    leader.close()
    follower.close()
    runtime.restore()
  }
})

test('unit: follower transact resolves false when the leader has no open socket', async () => {
  const runtime = installBrowserLikeRuntime({ locks: undefined })
  const leader = new StationClient('ws://mock/no-open-socket')
  const follower = new StationClient('ws://mock/no-open-socket')

  try {
    leader.isLeader = true
    leader.webSocket = null

    const response = await follower.transact({ type: 'needs-socket' })
    assert.equal(response, false)
  } finally {
    leader.close()
    follower.close()
    runtime.restore()
  }
})

test('unit: transact ttl clears stale follower routing state on the leader', async () => {
  const runtime = installBrowserLikeRuntime()
  installMockBaseStation('ws://mock/ttl', {
    onRequest() {
      return null
    },
  })
  const leader = new StationClient('ws://mock/ttl')
  const follower = new StationClient('ws://mock/ttl')

  try {
    await waitFor(() => leader.webSocket?.readyState === MockWebSocket.OPEN)

    const pending = follower
      .transact({ type: 'slow' }, { ttlMs: 20 })
      .catch((error) => error)

    await waitFor(() => leader.pendingTransactTargets.size === 1)
    await waitFor(() => leader.pendingTransactTargets.size === 0, {
      timeoutMs: 500,
    })

    follower.close()
    leader.close()
    await pending
  } finally {
    leader.close()
    follower.close()
    runtime.restore()
  }
})
