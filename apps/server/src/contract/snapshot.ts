import type { Finding, SnapshotDocument } from "@deck/schema";

/** The five mutually-exclusive host collection states. */
export type HostCollectionState =
  | "fresh"
  | "stale"
  | "partial"
  | "unreachable"
  | "never-collected";

/** Derived collection state for one declared or observed host. */
export interface HostState {
  /** Primary five-state label. Partial remains primary even when old. */
  state: HostCollectionState;
  /** Snapshot collection timestamp, or null for unreachable/never-collected. */
  collectedAt: string | null;
  /** Non-negative age at derivation time, or null when no timestamp exists. */
  ageMs: number | null;
  /** True for stale and for an old partial collection. */
  pastStaleThreshold: boolean;
}

/** Sanitized last snapshot-read failure safe for API and UI display. */
export interface SnapshotReadError {
  /** Stable failure code from `SnapshotReadErrorCode`. */
  code: string;
  /** Remediation-oriented summary; never contains source or document text. */
  message: string;
  /** HTTP status for `HTTP_STATUS`; absent for all other failures. */
  httpStatus?: number;
}

/** Stable payload served by `GET /api/providers/snapshot`. */
export interface SnapshotProviderResult {
  /** Whole validated snapshot object, including untouched drift findings. */
  snapshot: SnapshotDocument;
  /** Every finding returned by `validateSnapshot(snapshot, config)`. */
  findings: readonly Finding[];
  /** Derived states keyed by the union of declared and observed host names. */
  hostStates: Readonly<Record<string, HostState>>;
  /** RFC 3339 time of the latest successful changed or unchanged read. */
  lastReadAt: string;
  /** Latest failed read, null immediately after a successful read. */
  readError: SnapshotReadError | null;
}
