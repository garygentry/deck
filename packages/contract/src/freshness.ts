export type FreshnessState = "fresh" | "stale" | "unreachable" | "static" | "pending";

export interface FreshnessStamp {
  state: FreshnessState;
  observedAt: string | null;
  ageMs: number | null;
  ttlMs: number | null;
}

export interface ProviderEnvelope<T = unknown> {
  id: string;
  kind: string;
  freshness: FreshnessStamp;
  data: T | null;
  error: { message: string } | null;
}
