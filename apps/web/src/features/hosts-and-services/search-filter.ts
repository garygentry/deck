import type { HostCollectionState } from "@deck/server";
import type { HostRow, ServiceRow } from "./model.js";

/** Observed-state selection token; adds the explicit absent state to `ServiceState`. */
export type ObservedStateFilter =
  | "running"
  | "stopped"
  | "degraded"
  | "unknown"
  | "not-observed";

export interface HostFilterCriteria {
  /** Case-insensitive free-text query over documented host fields. */
  query: string;
  /** Selected declared host kinds; empty means all kinds. */
  kinds: readonly string[];
  /** Selected collection states; empty means all states. */
  states: readonly HostCollectionState[];
  /** Whether declared hosts marked hidden are excluded. */
  excludeHidden: boolean;
}

export interface ServiceFilterCriteria {
  /** Case-insensitive free-text query over documented service fields. */
  query: string;
  /** Selected host names; empty means every host. */
  hosts: readonly string[];
  /** Selected observed states, including the explicit absent state. */
  observedStates: readonly ObservedStateFilter[];
  /** Whether services declared hidden are excluded. */
  excludeHidden: boolean;
}

export interface FilterResult<T> {
  /** Rows surviving every active criterion in original stable order. */
  rows: readonly T[];
  /** Input row count before filtering. */
  total: number;
  /** Number removed by all active criteria. */
  hidden: number;
}

/** Exact empty host criteria: no query, no dimension selected, hidden shown. */
export const NO_HOST_FILTERS: HostFilterCriteria = Object.freeze({
  query: "",
  kinds: Object.freeze([]),
  states: Object.freeze([]),
  excludeHidden: false,
});

/** Exact empty service criteria: no query, no dimension selected, hidden shown. */
export const NO_SERVICE_FILTERS: ServiceFilterCriteria = Object.freeze({
  query: "",
  hosts: Object.freeze([]),
  observedStates: Object.freeze([]),
  excludeHidden: false,
});

/** Normalize free text exactly once for case-insensitive substring matching. */
function normalize(value: string): string {
  return value.trim().toLocaleLowerCase("en-US");
}

/** True when the query is empty or a substring of any normalized candidate field. */
function matchesText(fields: readonly (string | null | undefined)[], needle: string): boolean {
  if (needle === "") return true;
  for (const field of fields) {
    if (field != null && normalize(field).includes(needle)) return true;
  }
  return false;
}

/** Freeze a result while preserving input order and exact total/hidden counts. */
function freezeResult<T>(rows: readonly T[], matches: T[]): FilterResult<T> {
  return Object.freeze({
    rows: Object.freeze(matches),
    total: rows.length,
    hidden: rows.length - matches.length,
  });
}

/** Pure, stable, O(n) host projection with visible/total/hidden counts. */
export function filterHosts(
  rows: readonly HostRow[],
  criteria: HostFilterCriteria,
): FilterResult<HostRow> {
  const needle = normalize(criteria.query);
  const matches: HostRow[] = [];
  for (const row of rows) {
    // 1. free-text over name and declared purpose only.
    if (!matchesText([row.key, row.declared?.purpose], needle)) continue;
    // 2. declared kind; an undeclared row cannot match a non-empty kind selection.
    if (criteria.kinds.length > 0) {
      const kind = row.declared?.kind;
      if (kind === undefined || !criteria.kinds.includes(kind)) continue;
    }
    // 3. collection state; a no-snapshot row cannot match a non-empty state selection.
    if (criteria.states.length > 0) {
      const state = row.hostState?.state;
      if (state === undefined || !criteria.states.includes(state)) continue;
    }
    // 4. exclude only explicitly hidden declarations.
    if (criteria.excludeHidden && row.declared?.hidden === true) continue;
    matches.push(row);
  }
  return freezeResult(rows, matches);
}

/** Pure, stable, O(n) service projection with visible/total/hidden counts. */
export function filterServices(
  rows: readonly ServiceRow[],
  criteria: ServiceFilterCriteria,
): FilterResult<ServiceRow> {
  const needle = normalize(criteria.query);
  const matches: ServiceRow[] = [];
  for (const row of rows) {
    // 1. free-text over service name, host, and declared purpose only.
    if (!matchesText([row.key.name, row.key.host, row.declared?.purpose], needle)) {
      continue;
    }
    // 2. host membership.
    if (criteria.hosts.length > 0 && !criteria.hosts.includes(row.key.host)) continue;
    // 3. observed state; "not-observed" only for available reality with no observation.
    //    A no-snapshot row cannot match a non-empty observed-state selection.
    if (criteria.observedStates.length > 0) {
      const observed: ObservedStateFilter | null =
        row.reality === "available"
          ? (row.observed?.state ?? "not-observed")
          : null;
      if (observed === null || !criteria.observedStates.includes(observed)) continue;
    }
    // 4. exclude only explicitly hidden declarations; a service is never implicitly
    //    hidden because its host is hidden.
    if (criteria.excludeHidden && row.declared?.hidden === true) continue;
    matches.push(row);
  }
  return freezeResult(rows, matches);
}
