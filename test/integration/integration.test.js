import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { decode, encode } from '@msgpack/msgpack'
import { WebSocket, WebSocketServer } from 'ws'
import { StationClient } from '../../dist/index.js'
import {
  installBrowserLikeRuntime,
  waitFor,
} from '../shared/station-client-fixtures.mjs'

test('integration: two clients share one base station connection and transact through the leader', async () => {
  const readyTimeoutMs = 15_000
  const runtime = installBrowserLikeRuntime({ WebSocketImpl: WebSocket })
  const server = createServer()
  const wss = new WebSocketServer({ server })
  const state = {
    currentConnections: 0,
    messages: [],
    requests: [],
  }
  const sockets = new Set()

  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })

  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Failed to resolve integration test server port.')
  }

  const webSocketUrl = `ws://127.0.0.1:${address.port}/base-station`

  wss.on('connection', (socket) => {
    state.currentConnections += 1
    sockets.add(socket)

    socket.on('message', (data) => {
      const message = decode(new Uint8Array(data))

      if (
        Array.isArray(message) &&
        message[0] === 'station-client-request' &&
        typeof message[1] === 'string'
      ) {
        state.requests.push(message)
        socket.send(
          encode([
            'station-client-response',
            message[1],
            { ok: true, echo: message[2] },
          ])
        )
        return
      }

      state.messages.push(message)
    })

    socket.on('close', () => {
      sockets.delete(socket)
      state.currentConnections -= 1
    })
  })

  const leader = new StationClient(webSocketUrl)
  const follower = new StationClient(webSocketUrl)
  const followerMessages = []

  try {
    follower.addEventListener('message', (event) => {
      followerMessages.push(event.detail)
    })

    await waitFor(() => state.currentConnections === 1, {
      timeoutMs: readyTimeoutMs,
    })
    await waitFor(() => leader.webSocket?.readyState === WebSocket.OPEN, {
      timeoutMs: readyTimeoutMs,
    })

    const response = await follower.transact({ type: 'integration' })
    assert.deepEqual(response, {
      ok: true,
      echo: { type: 'integration' },
    })

    leader.relay({ type: 'relay', from: 'leader' })
    await waitFor(() => state.messages.length === 1)
    assert.deepEqual(state.messages[0], { type: 'relay', from: 'leader' })

    for (const socket of sockets) {
      socket.send(encode({ type: 'server', from: 'base-station' }))
    }

    await waitFor(() =>
      followerMessages.some((message) => message.type === 'server')
    )

    assert.equal(state.requests.length, 1)
    assert.equal(state.requests[0][0], 'station-client-request')
    assert.deepEqual(state.requests[0][2], { type: 'integration' })
  } finally {
    leader.close()
    follower.close()

    await new Promise((resolve) => {
      wss.close(() => {
        server.close(() => resolve())
      })
    })

    runtime.restore()
  }
})
