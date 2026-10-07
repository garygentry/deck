export type {
  ActionsCapabilityResponse,
  ApiError,
  HealthResponse,
  ProviderDescriptor,
  ProviderHealthEntry,
  ProviderParams,
  ProvidersResponse,
} from "./api.js";
export type { DeckConfig } from "./config.js";
export type {
  FreshnessStamp,
  FreshnessState,
  ProviderEnvelope,
} from "./freshness.js";
export { POLL_DEFAULTS } from "./provider.js";
export type {
  HostCollectionState,
  HostState,
  SnapshotProviderResult,
  SnapshotReadError,
} from "./snapshot.js";
export type {
  FailureFreshness,
  Provider,
  ProviderConfig,
  ProviderFetchContext,
  ProviderHealth,
} from "./provider.js";
export type { ConfigDirError, ExitClass, LoaderResult } from "../config/load.js";
export * from "../drift/index.js";

// Governed-actions surface consumed by apps/web via @deck/server (never @deck/schema).
// Types are re-exported from the module that DEFINES them; the barrel never re-declares.
export type { Action, ActionParam } from "@deck/schema";
export type {
  ActionOutcome,
  ActionRunEvent,
  StructuredRunnerInput,
} from "../actions/events.js";
export type {
  ActionParamValue,
  ParamError,
  ResolvedParams,
  ValidateResult,
} from "../actions/validate.js";
export { validateActionParams } from "../actions/validate.js";
export type {
  AuditDetail,
  AuditEntry,
  AuditListItem,
  AuditTarget,
} from "../actions/audit.js";

// Sources browsing surface consumed by apps/web via @deck/server (never @deck/schema).
// Exactly the six wire types the web renders; the server-internal store/reader/runtime types
// are NOT re-exported (they never cross the server→web boundary).
export type {
  FileReadResult,
  SourceKind,
  SourceManifest,
  SourceSearchMatch,
  SourceSearchResult,
  SourceTreeNode,
} from "../sources/tree.js";

// LLM usage surface consumed by apps/web via @deck/server.
export type {
  ClaudeUsage,
  CodexHistory,
  CodexHistoryDay,
  CodexUsage,
  LlmUsageHealth,
  LlmUsageResponse,
  TokenCounts,
  TranscriptTotals,
  UsageBar,
  UsageBarSource,
  UsageGroup,
  UsagePollMode,
  UsageSeverity,
  UsageSourceId,
  UsageSourceState,
  UsageSourceStatus,
  UsageThresholds,
} from "../llm-usage/types.js";
