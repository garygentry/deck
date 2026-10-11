import type { HostCollectionState } from "@deck/contract";
import type { CoverageRow, DriftFindingProjection, DriftSeverity, WaiverState } from "./types.js";

/** Fixed release behavior; no config/schema/environment setting is added. */
export const DRIFT_UI_DEFAULTS = Object.freeze({
  initialRowsPerGroup: 25,
  additionalRowsPerStep: 25,
  evidenceMaxDepth: 4,
  evidenceMaxBytes: 2_048,
} as const);

/** Attention-first host coverage order, stable for this release. */
export const COVERAGE_STATE_ORDER: readonly HostCollectionState[] = Object.freeze([
  "unreachable",
  "never-collected",
  "partial",
  "stale",
  "fresh",
]);

/** Ordinal severity rank; lower sorts first. */
const SEVERITY_RANK: Record<DriftSeverity, 0 | 1 | 2> = {
  error: 0,
  warning: 1,
  info: 2,
};

/** Active risk (unwaived/expired) ranks before an active waiver. */
function riskRank(state: WaiverState): 0 | 1 {
  return state === "active" ? 1 : 0;
}

/** Exact UTF-16 code-unit comparison; never locale-sensitive. */
function compareCodeUnits(left: string, right: string): -1 | 0 | 1 {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/** Compare projected findings using the release-stable risk order. */
export function compareDriftFindings(
  left: DriftFindingProjection,
  right: DriftFindingProjection,
): -1 | 0 | 1 {
  const bySeverity = SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity];
  if (bySeverity !== 0) return bySeverity < 0 ? -1 : 1;

  const byRisk = riskRank(left.waiverState) - riskRank(right.waiverState);
  if (byRisk !== 0) return byRisk < 0 ? -1 : 1;

  const byCategory = compareCodeUnits(left.category, right.category);
  if (byCategory !== 0) return byCategory;

  return compareCodeUnits(left.id, right.id);
}

/** Compare coverage by attention state and then deterministic host identity. */
export function compareCoverageRows(left: CoverageRow, right: CoverageRow): -1 | 0 | 1 {
  const byState = COVERAGE_STATE_ORDER.indexOf(left.state) - COVERAGE_STATE_ORDER.indexOf(right.state);
  if (byState !== 0) return byState < 0 ? -1 : 1;

  const byFolded = compareCodeUnits(left.host.toLowerCase(), right.host.toLowerCase());
  if (byFolded !== 0) return byFolded;

  return compareCodeUnits(left.host, right.host);
}
