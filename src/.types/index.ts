/**
 * Maps station client event names to their event payload shapes.
 *
 * @template T The application message shape.
 */
export type StationClientEventMap<T extends Record<string, unknown>> = {
  message: T
}

/**
 * Represents a strongly typed station client event listener.
 *
 * @template T The application message shape.
 * @template K The event type.
 */
export type StationClientEventListener<
  T extends Record<string, unknown>,
  K extends keyof StationClientEventMap<T>,
> =
  | ((event: CustomEvent<StationClientEventMap<T>[K]>) => void)
  | { handleEvent(event: CustomEvent<StationClientEventMap<T>[K]>): void }

/**
 * Resolves an event name to its corresponding listener type.
 *
 * @template T The application message shape.
 * @template K The event type.
 */
export type StationClientEventListenerFor<
  T extends Record<string, unknown>,
  K extends string,
> = K extends keyof StationClientEventMap<T>
  ? StationClientEventListener<T, K>
  : EventListenerOrEventListenerObject

/**
 * Represents a message exchanged over the local broadcast channel.
 *
 * @template T The application message shape.
 */
export type StationClientLocalMessageShape<T extends Record<string, unknown>> =
  | {
      kind: 'relay'
      message: T
    }
  | {
      kind: 'transact'
      id: string
      source: string
      ttlMs?: number
      message: T
    }
  | {
      kind: 'transact-response'
      id: string
      target: string
      message: T | false
    }
  | {
      kind: 'transact-abort'
      id: string
    }

/**
 * Represents a message exchanged with the station transport.
 *
 * @template T The application message shape.
 */
export type StationClientRemoteMessageShape<T extends Record<string, unknown>> =
  | T
  | readonly ['station-client-request', string, T]

/**
 * Represents the pending state of an in-flight transact operation.
 *
 * @template T The application message shape.
 */
export type StationClientPendingTransact<T extends Record<string, unknown>> = {
  resolve: (message: T | false) => void
  reject: (reason?: unknown) => void
  cleanup: () => void
}

/**
 * Represents the leader-side routing state for a pending transact operation.
 */
export type StationClientPendingTransactTarget = {
  target: string
  timeoutId: ReturnType<typeof setTimeout>
}

/**
 * Provides options for {@link StationClient.transact}.
 */
export type StationClientTransactOptions = {
  /**
   * An {@link AbortSignal} that can be used to cancel the operation.
   */
  signal?: AbortSignal

  /**
   * The leader-side stale-entry time-to-live, in milliseconds.
   */
  ttlMs?: number
}
