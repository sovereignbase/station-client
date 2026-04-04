/**
 * Maps OO-Struct event names to their event payload shapes.
 */
export type StationClientEventMap<T extends Record<string, unknown>> = {
  message: T
}

/**
 * Represents a strongly typed OO-Struct event listener.
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
