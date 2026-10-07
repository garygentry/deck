/**
 * The wire contract the server serves and the web reads: provider envelopes and freshness,
 * the default poll timing, and the snapshot provider's payload. It loads no server code, so
 * the browser bundle can import it at runtime.
 */
export type { FreshnessStamp, FreshnessState, ProviderEnvelope } from "./freshness.js";
export { POLL_DEFAULTS } from "./poll.js";
export type {
  HostCollectionState,
  HostState,
  SnapshotProviderResult,
  SnapshotReadError,
} from "./snapshot.js";
