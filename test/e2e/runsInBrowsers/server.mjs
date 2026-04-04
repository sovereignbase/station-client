import http from 'node:http'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, extname, resolve } from 'node:path'
import { decode, encode } from '@msgpack/msgpack'
import { WebSocketServer } from 'ws'

const browserTestRoot = dirname(fileURLToPath(import.meta.url))
const testRoot = resolve(browserTestRoot, '..')
const root = resolve(testRoot, '..', '..')
const sockets = new Set()
const state = {
  currentConnections: 0,
  totalConnections: 0,
  messages: [],
  requests: [],
}

const mimeTypes = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.json': 'application/json',
  '.map': 'application/json',
  '.css': 'text/css',
}

function safeResolve(base, pathname) {
  const resolved = resolve(base, '.' + pathname)
  if (!resolved.startsWith(base)) return null
  return resolved
}

function resetState() {
  for (const socket of sockets) {
    try {
      socket.close(1000, 'reset')
    } catch {}
  }

  sockets.clear()
  state.currentConnections = 0
  state.totalConnections = 0
  state.messages = []
  state.requests = []
}

function writeJson(res, value) {
  res.statusCode = 200
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(value))
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')

  if (url.pathname === '/__mock__/state' && req.method === 'GET') {
    writeJson(res, state)
    return
  }

  if (url.pathname === '/__mock__/reset' && req.method === 'POST') {
    resetState()
    res.statusCode = 204
    res.end()
    return
  }

  if (url.pathname === '/__mock__/broadcast' && req.method === 'POST') {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const message = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null')

    for (const socket of sockets) {
      if (socket.readyState !== 1) continue
      socket.send(encode(message))
    }

    res.statusCode = 204
    res.end()
    return
  }

  let pathname = url.pathname
  if (pathname === '/') pathname = '/runsInBrowsers/station-client.html'

  let filePath
  if (pathname.startsWith('/dist/')) filePath = safeResolve(root, pathname)
  else filePath = safeResolve(testRoot, pathname)

  if (!filePath) {
    res.statusCode = 400
    res.end('Bad request')
    return
  }

  try {
    const data = await readFile(filePath)
    res.statusCode = 200
    res.setHeader(
      'Content-Type',
      mimeTypes[extname(filePath)] || 'application/octet-stream'
    )
    res.end(data)
  } catch {
    res.statusCode = 404
    res.end('Not found')
  }
})

const wss = new WebSocketServer({ noServer: true })

wss.on('connection', (socket) => {
  sockets.add(socket)
  state.currentConnections += 1
  state.totalConnections += 1

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
    if (!sockets.delete(socket)) return
    state.currentConnections -= 1
  })
})

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  if (url.pathname !== '/base-station') {
    socket.destroy()
    return
  }

  wss.handleUpgrade(req, socket, head, (upgradedSocket) => {
    wss.emit('connection', upgradedSocket, req)
  })
})

const port = Number.parseInt(process.env.PORT || '4173', 10)
server.listen(port, '127.0.0.1', () => {
  console.log(`station-client test server running at http://127.0.0.1:${port}`)
})

function shutdown() {
  resetState()
  wss.close(() => {
    server.close(() => process.exit(0))
  })
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
