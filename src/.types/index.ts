/**
 * Maps station client event names to their event payload shapes.
 */
export type StationClientEventMap<T extends Record<string, unknown>> = {
  message: T
}

/**
 * Represents a strongly typed station client event listener.
 */
export type StationClientEventListener<
  T extends Record<string, unknown>,
  K extends keyof StationClientEventMap<T>,
> =
  | ((event: CustomEvent<StationClientEventMap<T>[K]>) => void)
  | { handleEvent(event: CustomEvent<StationClientEventMap<T>[K]>): void }

/**
 * Resolves an event name to its corresponding listener type.
 */
export type StationClientEventListenerFor<
  T extends Record<string, unknown>,
  K extends string,
> = K extends keyof StationClientEventMap<T>
  ? StationClientEventListener<T, K>
  : EventListenerOrEventListenerObject

export type StationClientLocalMessageShape<T extends Record<string, unknown>> =
  | {
      kind: 'relay'
      message: T
    }
  | {
      kind: 'transact'
      id: string
      source: string
      message: T
    }
  | {
      kind: 'transact-response'
      id: string
      target: string
      message: T
    }

export type StationClientRemoteMessageShape<T extends Record<string, unknown>> =
  | T
  | readonly ['station-client-request', string, T]
