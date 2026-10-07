import type { FreshnessStamp, HostCollectionState, SnapshotReadError } from "../contract/index.js";
import type { JsonValue, Waiver } from "@deck/schema";

/** Closed severity vocabulary published by snapshot.schema.json. */
export type DriftSeverity = "error" | "warning" | "info";

/** Display-time waiver classification evaluated against the supplied clock. */
export type WaiverState = "unwaived" | "active" | "expired";

/** One retained drift finding with display-time waiver classification. */
export interface DriftFindingProjection {
  /** Stable source finding id. */
  readonly id: string;
  /** Published severity. */
  readonly severity: DriftSeverity;
  /** Open category string retained exactly. */
  readonly category: string;
  /** Plain-language source message rendered as inert text. */
  readonly message: string;
  /** Location host retained exactly. */
  readonly host: string;
  /** Optional location service, normalized to null. */
  readonly service: string | null;
  /** Optional location path, normalized to null. */
  readonly path: string | null;
  /** Expected JSON value when supplied; undefined preserves field absence. */
  readonly expected: JsonValue | undefined;
  /** Observed JSON value when supplied; undefined preserves field absence. */
  readonly observed: JsonValue | undefined;
  /** Independent frozen waiver copy preserving optional `until`, or null. */
  readonly waiver: Readonly<Waiver> | null;
  /** Classification at `derivedAt`. */
  readonly waiverState: WaiverState;
  /** Fixed sanitized warning for malformed expiry, otherwise null. */
  readonly waiverWarning: string | null;
}

/** Service-level subgroup; null denotes host-level findings. */
export interface FindingSubgroup {
  /** Service identity, or null for the host-level subgroup. */
  readonly service: string | null;
  /** Deterministically risk-ordered findings. */
  readonly findings: readonly DriftFindingProjection[];
}

/** All findings for one host, split into host then service subgroups. */
export interface FindingHostGroup {
  /** Exact host identity. */
  readonly host: string;
  /** Host-level subgroup first, followed by service names in ordinal order. */
  readonly subgroups: readonly FindingSubgroup[];
  /** Sum of every subgroup's findings. */
  readonly findingCount: number;
}

/** Failed collector data available on a partial host. */
export interface CollectorFailureProjection {
  /** Collector name rendered as inert text. */
  readonly name: string;
  /** Sanitized upstream reason rendered as inert text and never logged. */
  readonly reason: string;
}

/** One source-published host coverage state with display-time age. */
export interface CoverageRow {
  /** Host key from `SnapshotProviderResult.hostStates`. */
  readonly host: string;
  /** The provider's authoritative five-state classification. */
  readonly state: HostCollectionState;
  /** Absolute source collection time, or null. */
  readonly collectedAt: string | null;
  /** Non-negative age at derivation, or null when no timestamp exists. */
  readonly ageMs: number | null;
  /** Provider-published stale-threshold fact retained unchanged. */
  readonly pastStaleThreshold: boolean;
  /** Failed collector details for partial hosts; empty otherwise. */
  readonly failedCollectors: readonly CollectorFailureProjection[];
}

/** Counts of active risk only; active waivers are excluded. */
export interface DriftSeverityCounts {
  /** Active error findings. */
  readonly error: number;
  /** Active warning findings. */
  readonly warning: number;
  /** Active informational findings. */
  readonly info: number;
}

/** Complete five-state host population counts. */
export interface CoverageCounts {
  /** Hosts currently classified fresh. */
  readonly fresh: number;
  /** Hosts currently classified stale. */
  readonly stale: number;
  /** Hosts with partial collector success. */
  readonly partial: number;
  /** Hosts currently classified unreachable. */
  readonly unreachable: number;
  /** Hosts with no successful collection. */
  readonly "never-collected": number;
}

/** Stable feature-owned summary consumed by UI adapters and tests. */
export interface DriftSummary {
  /** Active-risk counts by severity. */
  readonly activeSeverity: DriftSeverityCounts;
  /** Complete host counts by authoritative coverage state. */
  readonly coverage: CoverageCounts;
  /** Findings with waivers active at derivation time. */
  readonly activeWaivers: number;
  /** Findings whose waiver is expired or malformed. */
  readonly expiredWaivers: number;
  /** All source drift findings, independent of filtering. */
  readonly totalFindings: number;
  /** All authoritative host-state keys. */
  readonly totalHosts: number;
}

/** One complete derivation from one provider envelope at one explicit time. */
export interface DriftProjection {
  /** Snapshot's descriptive generation timestamp. */
  readonly snapshotGeneratedAt: string;
  /** Provider observation timestamp, or null when absent. */
  readonly providerObservedAt: string | null;
  /** Provider freshness facts retained unchanged. */
  readonly providerFreshness: FreshnessStamp;
  /** Provider's most recent successful read timestamp. */
  readonly lastSuccessfulReadAt: string;
  /** Retained provider read failure, or null. */
  readonly readError: SnapshotReadError | null;
  /** Explicit clock instant used for waiver and age derivation. */
  readonly derivedAt: string;
  /** Complete, unfiltered generation summary. */
  readonly summary: DriftSummary;
  /** Deterministically ordered host finding groups. */
  readonly findingGroups: readonly FindingHostGroup[];
  /** Deterministically ordered authoritative coverage rows. */
  readonly coverageRows: readonly CoverageRow[];
}

/** Exact service identity; service names alone are not unique. */
export interface DriftServiceIdentity {
  /** Exact host identity containing the service. */
  readonly host: string;
  /** Exact service name within the host. */
  readonly service: string;
}

/** Composable finding and coverage criteria. Empty sets mean all values. */
export interface DriftFilters {
  /** Locale-independent case-folded substring query. */
  readonly text: string;
  /** Selected finding severities; empty means every severity. */
  readonly severities: ReadonlySet<DriftSeverity>;
  /** Selected finding hosts; empty means every host. */
  readonly hosts: ReadonlySet<string>;
  /** Collision-free keys produced by `driftServiceFacetKey`. */
  readonly services: ReadonlySet<string>;
  /** Selected open category strings; empty means every category. */
  readonly categories: ReadonlySet<string>;
  /** Selected display-time waiver states; empty means every state. */
  readonly waiverStates: ReadonlySet<WaiverState>;
  /** Selected coverage hosts; empty means every host. */
  readonly coverageHosts: ReadonlySet<string>;
  /** Selected authoritative coverage states; empty means every state. */
  readonly coverageStates: ReadonlySet<HostCollectionState>;
}

/** Counts for only rows surviving the active criteria. */
export interface FilteredDriftCounts {
  /** Findings surviving finding criteria. */
  readonly findings: number;
  /** Host groups containing at least one surviving finding. */
  readonly hostsWithFindings: number;
  /** Coverage rows surviving coverage criteria. */
  readonly coverageRows: number;
}

/** Filtered references plus the complete generation totals. */
export interface FilteredDriftProjection {
  /** Complete immutable projection from which this result was filtered. */
  readonly source: DriftProjection;
  /** Host groups containing only surviving finding references. */
  readonly findingGroups: readonly FindingHostGroup[];
  /** Coverage rows surviving coverage criteria. */
  readonly coverageRows: readonly CoverageRow[];
  /** Counts for currently surviving rows. */
  readonly filtered: FilteredDriftCounts;
  /** Complete generation summary, unaffected by filters. */
  readonly total: DriftSummary;
  /** Whether any criterion differs from its empty/default value. */
  readonly hasActiveFilters: boolean;
}

/** Recursive readonly JSON shape accepted by the structural renderer. */
export type ReadonlyJsonValue =
  | string
  | number
  | boolean
  | null
  | readonly ReadonlyJsonValue[]
  | { readonly [key: string]: ReadonlyJsonValue };

/** Optional bounds applied when building an inert evidence preview. */
export interface EvidencePreviewLimits {
  /** Maximum displayed nesting before the preview marks a branch omitted. */
  readonly maxDepth?: number;
  /** Maximum deterministic UTF-8 serialized bytes before bounded mode. */
  readonly maxBytes?: number;
}

/** Stable reason a preview differs structurally from the supplied value. */
export type EvidencePreviewReason = "depth" | "bytes";

/** Bounded preview plus exact supplied value for on-demand inspection. */
export interface EvidencePreview {
  /** Bounded inert tree rendered initially. */
  readonly preview: ReadonlyJsonValue;
  /** Exact input retained in memory for explicit full inspection. */
  readonly fullValue: ReadonlyJsonValue;
  /** Whether preview differs structurally from the supplied value. */
  readonly truncated: boolean;
  /** Deterministically ordered reasons for truncation. */
  readonly reasons: readonly EvidencePreviewReason[];
  /** UTF-8 byte count of deterministic full serialization. */
  readonly serializedBytes: number;
  /** Deepest level encountered in the full value. */
  readonly observedDepth: number;
}

/** Stable machine-readable projection failure codes. */
export type DriftProjectionErrorCode =
  | "INVALID_CLOCK"
  | "INVALID_INPUT"
  | "DERIVATION_FAILED";

/** Fixed-message projection failure safe for UI and diagnostics. */
export class DriftProjectionError extends Error {
  /** Stable runtime error class name. */
  readonly name = "DriftProjectionError";

  constructor(
    /** Stable machine-readable projection failure code. */
    readonly code: DriftProjectionErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}
