import { DriftProjectionError } from "./types.js";
import type {
  CoverageRow,
  DriftFilters,
  DriftFindingProjection,
  DriftProjection,
  DriftServiceIdentity,
  FilteredDriftProjection,
  FindingHostGroup,
  FindingSubgroup,
} from "./types.js";

/**
 * Collision-free service facet key: `JSON.stringify([host, service])`.
 * Array order is host then service; neither value is case-folded. Callers must
 * never use delimiter concatenation or a bare service name, because service
 * names are not globally unique.
 */
export function driftServiceFacetKey(identity: DriftServiceIdentity): string {
  return JSON.stringify([identity.host, identity.service]);
}

/** Snapshot of one supplied `ReadonlySet` taken once, never aliasing the caller's set. */
function snapshotSet<T>(set: ReadonlySet<T>): Set<T> {
  const copy = new Set<T>();
  for (const value of set) copy.add(value);
  return copy;
}

/** Normalized, caller-independent view of the supplied filter criteria. */
interface NormalizedFilters {
  readonly text: string;
  readonly severities: ReadonlySet<string>;
  readonly hosts: ReadonlySet<string>;
  readonly services: ReadonlySet<string>;
  readonly categories: ReadonlySet<string>;
  readonly waiverStates: ReadonlySet<string>;
  readonly coverageHosts: ReadonlySet<string>;
  readonly coverageStates: ReadonlySet<string>;
}

/** Validate the minimal complete-projection shape an untyped caller could violate. */
function assertProjection(projection: DriftProjection): void {
  if (
    typeof projection !== "object" ||
    projection === null ||
    !Array.isArray(projection.findingGroups) ||
    !Array.isArray(projection.coverageRows) ||
    typeof projection.summary !== "object" ||
    projection.summary === null
  ) {
    throw new DriftProjectionError("INVALID_INPUT", "Drift filters require a complete projection.");
  }
}

/**
 * True when the normalized query is empty or a substring of at least one
 * case-folded searchable field: id, message, category, host, non-null service,
 * or non-null path. Evidence and waiver metadata are never searched.
 */
function textMatches(finding: DriftFindingProjection, query: string): boolean {
  if (query === "") return true;
  if (finding.id.toLowerCase().includes(query)) return true;
  if (finding.message.toLowerCase().includes(query)) return true;
  if (finding.category.toLowerCase().includes(query)) return true;
  if (finding.host.toLowerCase().includes(query)) return true;
  if (finding.service !== null && finding.service.toLowerCase().includes(query)) return true;
  if (finding.path !== null && finding.path.toLowerCase().includes(query)) return true;
  return false;
}

/** Every active finding criterion must pass; selected values within a set are OR. */
function findingMatches(finding: DriftFindingProjection, filters: NormalizedFilters): boolean {
  if (!textMatches(finding, filters.text)) return false;
  if (filters.severities.size > 0 && !filters.severities.has(finding.severity)) return false;
  if (filters.hosts.size > 0 && !filters.hosts.has(finding.host)) return false;
  if (filters.services.size > 0) {
    // A service facet never matches a host-level finding.
    if (finding.service === null) return false;
    if (!filters.services.has(driftServiceFacetKey({ host: finding.host, service: finding.service }))) {
      return false;
    }
  }
  if (filters.categories.size > 0 && !filters.categories.has(finding.category)) return false;
  if (filters.waiverStates.size > 0 && !filters.waiverStates.has(finding.waiverState)) return false;
  return true;
}

/** Walk finding groups once, reusing surviving references and freezing replacement shells. */
function filterFindingGroups(
  projection: DriftProjection,
  filters: NormalizedFilters,
): { readonly groups: readonly FindingHostGroup[]; readonly findings: number } {
  const outGroups: FindingHostGroup[] = [];
  let totalFindings = 0;

  for (const group of projection.findingGroups) {
    const outSubgroups: FindingSubgroup[] = [];
    let groupCount = 0;
    let groupChanged = false;

    for (const subgroup of group.subgroups) {
      const survivors: DriftFindingProjection[] = [];
      for (const finding of subgroup.findings) {
        if (findingMatches(finding, filters)) survivors.push(finding);
      }

      if (survivors.length === subgroup.findings.length) {
        // Every finding survived — reuse the source subgroup by reference.
        outSubgroups.push(subgroup);
        groupCount += subgroup.findings.length;
      } else if (survivors.length > 0) {
        groupChanged = true;
        outSubgroups.push(
          Object.freeze({ service: subgroup.service, findings: Object.freeze(survivors) }),
        );
        groupCount += survivors.length;
      } else {
        // Empty filtered subgroup is omitted from the result but never from source.
        groupChanged = true;
      }
    }

    if (outSubgroups.length === 0) continue;

    totalFindings += groupCount;
    if (!groupChanged && outSubgroups.length === group.subgroups.length) {
      // Every subgroup survived intact — reuse the source host group by reference.
      outGroups.push(group);
    } else {
      outGroups.push(
        Object.freeze({ host: group.host, subgroups: Object.freeze(outSubgroups), findingCount: groupCount }),
      );
    }
  }

  return { groups: outGroups, findings: totalFindings };
}

/** Walk coverage rows once; coverage criteria are independent of finding criteria. */
function filterCoverageRows(
  projection: DriftProjection,
  filters: NormalizedFilters,
): readonly CoverageRow[] {
  if (filters.coverageHosts.size === 0 && filters.coverageStates.size === 0) {
    return projection.coverageRows;
  }

  const survivors: CoverageRow[] = [];
  let allSurvive = true;
  for (const row of projection.coverageRows) {
    const hostOk = filters.coverageHosts.size === 0 || filters.coverageHosts.has(row.host);
    const stateOk = filters.coverageStates.size === 0 || filters.coverageStates.has(row.state);
    if (hostOk && stateOk) survivors.push(row);
    else allSurvive = false;
  }

  return allSurvive ? projection.coverageRows : Object.freeze(survivors);
}

/**
 * Filter one immutable drift projection into independently filtered finding and
 * coverage references while retaining complete-generation totals.
 *
 * @param projection - Complete immutable projection to filter.
 * @param filters - Composable finding and coverage criteria; empty sets mean all.
 * @returns Immutable filtered references, filtered counts, and complete totals.
 * @throws {DriftProjectionError} `INVALID_INPUT` when the projection is not a
 * complete shape. A well-formed but unknown facet value returns a zero-match
 * population for its domain and never throws.
 */
export function filterDriftProjection(
  projection: DriftProjection,
  filters: DriftFilters,
): FilteredDriftProjection {
  assertProjection(projection);

  // Snapshot every supplied set exactly once so later caller mutation cannot
  // change the meaning of this already-returned result; never mutate the input.
  const normalized: NormalizedFilters = {
    text: filters.text.trim().toLowerCase(),
    severities: snapshotSet(filters.severities),
    hosts: snapshotSet(filters.hosts),
    services: snapshotSet(filters.services),
    categories: snapshotSet(filters.categories),
    waiverStates: snapshotSet(filters.waiverStates),
    coverageHosts: snapshotSet(filters.coverageHosts),
    coverageStates: snapshotSet(filters.coverageStates),
  };

  const hasActiveFilters =
    normalized.text !== "" ||
    normalized.severities.size > 0 ||
    normalized.hosts.size > 0 ||
    normalized.services.size > 0 ||
    normalized.categories.size > 0 ||
    normalized.waiverStates.size > 0 ||
    normalized.coverageHosts.size > 0 ||
    normalized.coverageStates.size > 0;

  const { groups, findings } = filterFindingGroups(projection, normalized);
  const coverageRows = filterCoverageRows(projection, normalized);

  return Object.freeze({
    source: projection,
    findingGroups: Object.freeze(groups),
    coverageRows,
    filtered: Object.freeze({
      findings,
      hostsWithFindings: groups.length,
      coverageRows: coverageRows.length,
    }),
    total: projection.summary,
    hasActiveFilters,
  });
}
