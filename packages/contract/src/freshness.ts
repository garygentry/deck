import type { JsonValue } from "@deck/module-sdk";

export type FreshnessState = "fresh" | "stale" | "unreachable" | "static" | "pending";

export interface FreshnessStamp {
  state: FreshnessState;
  observedAt: string | null;
  ageMs: number | null;
  ttlMs: number | null;
}

/**
 * One widget's `select` over the envelope's data, evaluated on the server: the value (plain
 * JSON; `null` where the expression selects nothing), or why the expression failed on this
 * data.
 */
export type ProviderProjection = { value: JsonValue } | { error: string };

export interface ProviderEnvelope<T = unknown> {
  id: string;
  kind: string;
  freshness: FreshnessStamp;
  data: T | null;
  error: { message: string } | null;
  /**
   * The `select` of each widget that reads this provider, over `data`, by the widget's id
   * (`widget:ui/<page>.<name>`). Absent when no widget selects from it, and empty while there
   * is no data. An older server never sends it.
   */
  projections?: Readonly<Record<string, ProviderProjection>>;
}
