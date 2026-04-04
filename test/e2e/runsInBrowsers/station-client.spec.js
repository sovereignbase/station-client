import { expect, test } from '@playwright/test'

const baseHttpUrl = process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:4173'

function getBaseStationState() {
  return fetch(`${baseHttpUrl}/__mock__/state`).then((response) =>
    response.json()
  )
}

function resetBaseStation() {
  return fetch(`${baseHttpUrl}/__mock__/reset`, { method: 'POST' })
}

function broadcastFromBaseStation(message) {
  return fetch(`${baseHttpUrl}/__mock__/broadcast`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(message),
  })
}

function getWebSocketUrl() {
  return new URL('/base-station', baseHttpUrl).toString().replace(/^http/, 'ws')
}

test('station-client browser relay synchronizes between tabs without echoing to sender', async ({
  browser,
}) => {
  const context = await browser.newContext()
  const senderPage = await context.newPage()
  const receiverPage = await context.newPage()

  try {
    await senderPage.goto('/runsInBrowsers/station-client.html')
    await receiverPage.goto('/runsInBrowsers/station-client.html')

    await senderPage.waitForFunction(() => globalThis.__STATION_CLIENT_TEST__)
    await receiverPage.waitForFunction(() => globalThis.__STATION_CLIENT_TEST__)

    await senderPage.evaluate(() => {
      globalThis.__STATION_CLIENT_TEST__.create('sender')
    })
    await receiverPage.evaluate(() => {
      globalThis.__STATION_CLIENT_TEST__.create('receiver')
    })

    await senderPage.evaluate(() => {
      globalThis.__STATION_CLIENT_TEST__.relay('sender', {
        type: 'relay',
        value: 'hello from sender',
      })
    })

    await receiverPage.waitForFunction(
      () =>
        globalThis.__STATION_CLIENT_TEST__.getMessages('receiver').length === 1
    )

    const senderMessages = await senderPage.evaluate(() =>
      globalThis.__STATION_CLIENT_TEST__.getMessages('sender')
    )
    const receiverMessages = await receiverPage.evaluate(() =>
      globalThis.__STATION_CLIENT_TEST__.getMessages('receiver')
    )

    expect(senderMessages).toEqual([])
    expect(receiverMessages).toEqual([
      {
        type: 'relay',
        value: 'hello from sender',
      },
    ])
  } finally {
    if (!senderPage.isClosed()) {
      await senderPage.evaluate(() =>
        globalThis.__STATION_CLIENT_TEST__?.closeAll?.()
      )
    }
    if (!receiverPage.isClosed()) {
      await receiverPage.evaluate(() =>
        globalThis.__STATION_CLIENT_TEST__?.closeAll?.()
      )
    }
    await context.close()
  }
})

test('station-client browser transact resolves against the base station mock', async ({
  browser,
}) => {
  await resetBaseStation()

  const context = await browser.newContext()
  await context.addInitScript(() => {
    if (globalThis.navigator.locks) return

    const locks = {
      request: async (_name, _options, callback) =>
        callback({ name: 'mock-base-station-lock' }),
    }

    try {
      Object.defineProperty(globalThis.navigator, 'locks', {
        configurable: true,
        value: locks,
      })
    } catch {
      Object.defineProperty(
        Object.getPrototypeOf(globalThis.navigator),
        'locks',
        {
          configurable: true,
          get: () => locks,
        }
      )
    }
  })

  const page = await context.newPage()

  try {
    await page.goto('/runsInBrowsers/station-client.html')
    await page.waitForFunction(() => globalThis.__STATION_CLIENT_TEST__)

    await page.evaluate((webSocketUrl) => {
      globalThis.__STATION_CLIENT_TEST__.create('client', webSocketUrl)
    }, getWebSocketUrl())

    await expect
      .poll(async () => {
        const state = await getBaseStationState()
        return state.currentConnections
      })
      .toBe(1)

    const response = await page.evaluate(() =>
      globalThis.__STATION_CLIENT_TEST__.transact('client', {
        type: 'request',
        value: 'ping',
      })
    )

    expect(response).toEqual({
      ok: true,
      echo: {
        type: 'request',
        value: 'ping',
      },
    })

    await page.evaluate(() => {
      globalThis.__STATION_CLIENT_TEST__.relay('client', {
        type: 'relay',
        value: 'hello base station',
      })
    })

    await expect
      .poll(async () => {
        const state = await getBaseStationState()
        return state.messages.length
      })
      .toBe(1)

    await broadcastFromBaseStation({
      type: 'server',
      value: 'hello browser',
    })

    await page.waitForFunction(() =>
      globalThis.__STATION_CLIENT_TEST__
        .getMessages('client')
        .some((message) => message.type === 'server')
    )

    const state = await getBaseStationState()
    const messages = await page.evaluate(() =>
      globalThis.__STATION_CLIENT_TEST__.getMessages('client')
    )

    expect(state.currentConnections).toBe(1)
    expect(state.requests).toHaveLength(1)
    expect(state.requests[0][0]).toBe('station-client-request')
    expect(state.requests[0][2]).toEqual({
      type: 'request',
      value: 'ping',
    })
    expect(state.messages).toEqual([
      {
        type: 'relay',
        value: 'hello base station',
      },
    ])
    expect(messages).toContainEqual({
      type: 'server',
      value: 'hello browser',
    })
  } finally {
    if (!page.isClosed()) {
      await page.evaluate(() =>
        globalThis.__STATION_CLIENT_TEST__?.closeAll?.()
      )
    }
    await context.close()
    await resetBaseStation()
  }
})
