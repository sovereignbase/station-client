import { StationClient } from '/runsInBrowsers/station-client.browser.js'

const clients = new Map()

function getRecord(id) {
  const record = clients.get(id)
  if (!record) throw new Error(`Unknown client: ${id}`)
  return record
}

function closeClient(id) {
  const record = clients.get(id)
  if (!record) return false

  record.client.close()
  clients.delete(id)
  return true
}

globalThis.__STATION_CLIENT_TEST__ = {
  create(id, webSocketUrl = '') {
    closeClient(id)

    const messages = []
    const client = new StationClient(webSocketUrl)
    client.addEventListener('message', (event) => {
      messages.push(event.detail)
    })

    clients.set(id, { client, messages })
    return true
  },

  relay(id, message) {
    getRecord(id).client.relay(message)
    return true
  },

  transact(id, message, options) {
    return getRecord(id).client.transact(message, options)
  },

  getMessages(id) {
    return [...getRecord(id).messages]
  },

  clearMessages(id) {
    getRecord(id).messages.length = 0
    return true
  },

  close(id) {
    return closeClient(id)
  },

  closeAll() {
    for (const id of clients.keys()) closeClient(id)
    return true
  },
}

const status = document.getElementById('status')
if (status) status.textContent = 'ready'
