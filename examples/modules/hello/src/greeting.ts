/** The `hello` provider's data: the server half serves it, the web half reads it. */
export interface Greeting {
  message: string;
  /** When the provider last ran, as an ISO 8601 date-time. */
  servedAt: string;
}

/** The module's config section, `modules.hello` (its schema is in deck-module.json). */
export interface HelloConfig {
  greeting?: string;
}

export const DEFAULT_GREETING = "Hello from a runtime module";
