/** Context supplied by the registry to every provider poll. */
export interface ProviderFetchContext {
  /** Aborted when the configured provider timeout expires. */
  signal: AbortSignal;
}

/** Failure-to-freshness policy; default preserves existing provider behavior. */
export type FailureFreshness = "immediate-unreachable" | "age-retained";

export interface Provider<T = unknown> {
  /** Stable provider instance id used by API lookup. */
  readonly id: string;
  /** Provider implementation kind used by discovery and health. */
  readonly kind: string;
  /** Return the latest cached/non-I/O provider health. */
  health(): Promise<ProviderHealth>;
  /** Existing zero-argument implementations remain assignable. */
  fetch(context?: ProviderFetchContext): Promise<T>;
  /** Optionally project a failed poll into retained data without recording success. */
  onFetchError?(error: unknown, retainedData: Readonly<T> | null): T | null;
}

export interface ProviderHealth {
  ok: boolean;
  detail?: string;
}

export interface ProviderConfig {
  pollIntervalMs?: number;
  ttlMs?: number;
  unreachableAfterMs?: number;
  timeoutMs?: number;
  /** Defaults to `"immediate-unreachable"`. */
  failureFreshness?: FailureFreshness;
}

export { POLL_DEFAULTS } from "@deck/contract";
