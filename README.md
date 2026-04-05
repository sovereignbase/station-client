# station-client

Local-first station client for same-origin tabs and workers that share an
opportunistic Sovereignbase base station transport. It uses
`BroadcastChannel` for immediate local delivery and elects a single leader
context to own the upstream WebSocket connection.

## Compatibility

- Runtimes: modern browsers and worker-like hosts with the APIs below;
- Module format: ESM and CJS builds.
- Required globals / APIs: `BroadcastChannel`, `WebSocket`, `AbortSignal`,
  `EventTarget`, `CustomEvent`, `MessageEvent`, `DOMException`,
  `crypto.randomUUID`; upstream leadership additionally requires
  `navigator.locks` and `navigator.onLine`.
- TypeScript: bundled types.

## Goals

- Local-first coordination across same-origin contexts.
- A single upstream owner per coordination group.
- Fire-and-forget `relay()` and request/response `transact()`.
- Generic message payloads without package-defined application semantics.
- Small public API with explicit shutdown and cancellation behavior.

## Installation

```sh
npm install @sovereignbase/station-client
# or
pnpm add @sovereignbase/station-client
# or
yarn add @sovereignbase/station-client
# or
bun add @sovereignbase/station-client
# or
deno add jsr:@sovereignbase/station-client
# or
vlt install jsr:@sovereignbase/station-client
```

## Usage

```ts
import { StationClient } from '@sovereignbase/station-client'
import { OOStruct } from '@sovereignbase/convergent-replicated-struct'

type State = {
  name: string
  amount: number
  flag: boolean
}

const station = new StationClient<Partial<State>>()
const snapshot =
  JSON.parse(localStorage.getItem('state') ?? 'null') ?? undefined
const state = new OOStruct<State>(
  {
    name: '',
    amount: 0,
    flag: false,
  },
  snapshot
)

const nameInput = document.getElementById('name') as HTMLInputElement
const amountInput = document.getElementById('amount') as HTMLInputElement
const flagInput = document.getElementById('flag') as HTMLInputElement

nameInput.value = state.read('name')
amountInput.value = state.read('amount')
flagInput.checked = state.read('flag')

nameInput.addEventListener('change', (event) => {
  state.update('name', (event.target as HTMLInputElement).value)
  state.snapshot()
})

amountInput.addEventListener('change', (event) => {
  state.update('amount', (event.target as HTMLInputElement).valueAsNumber)
  state.snapshot()
})

flagInput.addEventListener('change', (event) => {
  state.update('flag', (event.target as HTMLInputElement).checked)
  state.snapshot()
})

state.addEventListener('snapshot', (event) => {
  localStorage.setItem('state', JSON.stringify(event.detail))
})

state.addEventListener('delta', (event) => {
  station.relay(event.detail)
})

station.addEventListener('message', (event) => {
  state.merge(event.detail)
})

state.addEventListener('change', (event) => {
  const { name, amount, flag } = event.detail
  if (name !== undefined) nameInput.value = name
  if (amount !== undefined) amountInput.value = String(amount)
  if (flag !== undefined) flagInput.checked = flag
})
```

### Events

`message` events are emitted for:

- relayed messages received from other same-origin contexts
- non-transaction messages received from the base station

`relay()` does not loop a `message` event back into the same instance.
Transaction responses resolve the promise returned by `transact()` instead of
emitting a `message` event.

## Runtime behavior

### Local coordination

Every instance joins a `BroadcastChannel` derived from its configured base
station URL. One context becomes leader through the Web Locks API and owns the
active upstream transport for that coordination group.

### Upstream transport

The leader attempts to keep a WebSocket open while the host is online. Outbound
messages are MessagePack-encoded before transport.

### Transactions

`transact(message, options)` returns `Promise<T | false>`.

- It resolves with `false` when the request cannot presently be issued.
- It rejects when `options.signal` is aborted.
- `options.ttlMs` controls stale leader-side routing cleanup for follower
  requests. It is not a general request timeout.

### Wire convention

The current JavaScript binding uses these MessagePack payload shapes:

- ordinary upstream messages: the application message value itself
- transaction request: `['station-client-request', id, message]`
- transaction response: `['station-client-response', id, message]`

## Tests

Command: `npm run test`

- Build: `npm run build`
- Coverage: `node test/run-coverage.mjs`
- Browser E2E: `node test/e2e/run.mjs`
- Playwright matrix: Chromium, Firefox, WebKit, Pixel 5, iPhone 12

The repository currently includes unit and integration coverage in Node plus
browser E2E coverage for the reference binding.

## License

Apache-2.0
