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

type Message =
  | { kind: 'presence'; online: boolean }
  | { kind: 'echo'; text: string }

const client = new StationClient<Message>('wss://example.com/base-station')

client.addEventListener('message', (event) => {
  console.log('received', event.detail)
})

client.relay({ kind: 'presence', online: true })

const controller = new AbortController()
const response = await client.transact(
  { kind: 'echo', text: 'hello' },
  { signal: controller.signal }
)

if (response !== false) {
  console.log('response', response)
}

client.close()
```

### Local-only mode

Construct with an empty string to skip upstream connectivity and use only
same-origin local coordination.

```ts
const client = new StationClient<{ kind: 'ping' }>()
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
