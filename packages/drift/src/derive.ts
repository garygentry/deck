import type {
  FreshnessStamp,
  HostCollectionState,
  ProviderEnvelope,
  SnapshotProviderResult,
  SnapshotReadError,
} from "@deck/contract";
import type { DriftFinding, JsonValue, ObservedHost, Waiver } from "@deck/schema";
import { compareCoverageRows, compareDriftFindings, COVERAGE_STATE_ORDER } from "./ordering.js";
import type {
  CollectorFailureProjection,
  CoverageRow,
  DriftFindingProjection,
  DriftProjection,
  DriftSeverity,
  FindingHostGroup,
  FindingSubgroup,
  WaiverState,
} from "./types.js";
import { DriftProjectionError } from "./types.js";

/** Fixed sanitized warning attached to a finding whose waiver expiry is unusable. */
const MALFORMED_WAIVER_WARNING = "Waiver expiry is malformed; treated as expired.";

/** Closed severity vocabulary, used only for defensive boundary validation. */
const SEVERITIES: ReadonlySet<string> = new Set<DriftSeverity>(["error", "warning", "info"]);

/** Closed coverage-state vocabulary, used only for defensive boundary validation. */
const COVERAGE_STATES: ReadonlySet<string> = new Set<HostCollectionState>(COVERAGE_STATE_ORDER);

/** Throw the fixed `INVALID_INPUT` failure when a consumed boundary invariant is violated. */
function assertInput(condition: unknown): asserts condition {
  if (!condition) {
    throw new DriftProjectionError("INVALID_INPUT", "Projection input is not an available snapshot generation.");
  }
}

/** Throw the fixed invalid-consumed-value failure for a structurally impossible field. */
function invalidValue(): never {
  throw new DriftProjectionError("INVALID_INPUT", "Projection input contains an invalid consumed value.");
}

/** A non-null, non-array object. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse a strict RFC 3339 date-time to a finite epoch, or return null when the
 * value is not a locale-independent RFC 3339 instant. `Date.parse` is never
 * consulted, so implementation-dependent strings are rejected.
 */
function parseRfc3339(value: string): number | null {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(?:([Zz])|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const fraction = match[7] ? Number(`0.${match[7]}`) : 0;

  if (month < 1 || month > 12) return null;
  if (day < 1 || day > daysInMonth(year, month)) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;

  let offsetMinutes = 0;
  if (!match[8]) {
    const offsetHour = Number(match[10]);
    const offsetMinute = Number(match[11]);
    if (offsetHour > 23 || offsetMinute > 59) return null;
    offsetMinutes = (offsetHour * 60 + offsetMinute) * (match[9] === "-" ? -1 : 1);
  }

  const utcMs = Date.UTC(year, month - 1, day, hour, minute, second, 0) + fraction * 1000 - offsetMinutes * 60_000;
  return Number.isFinite(utcMs) ? utcMs : null;
}

/** Days in a Gregorian month, honouring leap years. */
function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return leap ? 29 : 28;
  }
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

/** Internal immutable result of classifying one optional source waiver. */
interface ClassifiedWaiver {
  readonly waiver: Waiver | null;
  readonly state: WaiverState;
  readonly warning: string | null;
}

/** Copy waiver metadata verbatim, preserving the absence of an optional `until`. */
function copyWaiver(waiver: Waiver): Waiver {
  const copy: Waiver = { reason: waiver.reason, who: waiver.who };
  if (waiver.until !== undefined) copy.until = waiver.until;
  return copy;
}

/**
 * Copy and classify a source waiver against the explicit derivation clock.
 * Never removes or changes the source finding.
 */
function classifyWaiver(waiver: DriftFinding["waiver"], nowMs: number): ClassifiedWaiver {
  if (waiver === undefined || waiver === null) {
    return { waiver: null, state: "unwaived", warning: null };
  }
  assertInput(isPlainObject(waiver));
  assertInput(typeof waiver.reason === "string" && typeof waiver.who === "string");

  const copy = copyWaiver(waiver);
  const until = waiver.until;
  if (until === undefined) {
    return { waiver: copy, state: "active", warning: null };
  }

  const epoch = typeof until === "string" ? parseRfc3339(until) : null;
  if (epoch === null) {
    return { waiver: copy, state: "expired", warning: MALFORMED_WAIVER_WARNING };
  }
  if (epoch > nowMs) {
    return { waiver: copy, state: "active", warning: null };
  }
  return { waiver: copy, state: "expired", warning: null };
}

/**
 * Recursively copy an acyclic JSON value into an independently owned tree,
 * rejecting cycles, `undefined`, non-finite numbers, functions, symbols, and
 * non-JSON objects. Object own-key order and array order are preserved.
 */
function copyJson(value: unknown, seen: Set<object>): JsonValue {
  if (value === null) return null;

  const kind = typeof value;
  if (kind === "string" || kind === "boolean") return value as string | boolean;
  if (kind === "number") {
    if (!Number.isFinite(value as number)) invalidValue();
    return value as number;
  }
  if (kind !== "object") invalidValue();

  const object = value as object;
  if (seen.has(object)) invalidValue();
  seen.add(object);
  try {
    if (Array.isArray(object)) {
      const copy: JsonValue[] = [];
      for (const element of object) copy.push(copyJson(element, seen));
      return copy;
    }

    const proto = Object.getPrototypeOf(object);
    if (proto !== Object.prototype && proto !== null) invalidValue();

    const copy: Record<string, JsonValue> = {};
    for (const key of Object.keys(object)) {
      const nested = (object as Record<string, unknown>)[key];
      if (nested === undefined) invalidValue();
      copy[key] = copyJson(nested, seen);
    }
    return copy;
  } finally {
    seen.delete(object);
  }
}

/** Copy the optional supplied evidence value, preserving absence as `undefined`. */
function copyEvidence(value: unknown): JsonValue | undefined {
  return value === undefined ? undefined : copyJson(value, new Set<object>());
}

/** Project one source drift finding into an independently owned record. */
function projectFinding(finding: DriftFinding, nowMs: number): DriftFindingProjection {
  assertInput(isPlainObject(finding));
  assertInput(typeof finding.id === "string");
  assertInput(typeof finding.severity === "string" && SEVERITIES.has(finding.severity));
  assertInput(typeof finding.category === "string");
  assertInput(typeof finding.message === "string");
  assertInput(isPlainObject(finding.location));

  const location = finding.location;
  assertInput(typeof location.host === "string");
  assertInput(location.service === undefined || typeof location.service === "string");
  assertInput(location.path === undefined || typeof location.path === "string");

  const classified = classifyWaiver(finding.waiver, nowMs);

  return {
    id: finding.id,
    severity: finding.severity as DriftSeverity,
    category: finding.category,
    message: finding.message,
    host: location.host,
    service: location.service ?? null,
    path: location.path ?? null,
    expected: copyEvidence(finding.expected),
    observed: copyEvidence(finding.observed),
    waiver: classified.waiver,
    waiverState: classified.state,
    waiverWarning: classified.warning,
  };
}

/** Mutable severity accumulator. */
interface SeverityCounter {
  error: number;
  warning: number;
  info: number;
}

/** Mutable coverage accumulator over the five authoritative states. */
type CoverageCounter = Record<HostCollectionState, number>;

/**
 * Group projected findings by exact host then exact service, emitting the
 * host-level subgroup first and services in exact code-unit order.
 */
function buildFindingGroups(
  groups: Map<string, Map<string | null, DriftFindingProjection[]>>,
): FindingHostGroup[] {
  const hostGroups: FindingHostGroup[] = [];

  for (const host of [...groups.keys()].sort(compareCodeUnits)) {
    const subgroupMap = groups.get(host)!;
    const subgroups: FindingSubgroup[] = [];
    let findingCount = 0;

    const hostLevel = subgroupMap.get(null);
    if (hostLevel && hostLevel.length > 0) {
      const findings = [...hostLevel].sort(compareDriftFindings);
      findingCount += findings.length;
      subgroups.push({ service: null, findings });
    }

    const services = [...subgroupMap.keys()].filter((key): key is string => key !== null).sort(compareCodeUnits);
    for (const service of services) {
      const findings = [...subgroupMap.get(service)!].sort(compareDriftFindings);
      if (findings.length === 0) continue;
      findingCount += findings.length;
      subgroups.push({ service, findings });
    }

    hostGroups.push({ host, subgroups, findingCount });
  }

  return hostGroups;
}

/** Exact UTF-16 code-unit comparison used for host and service ordering. */
function compareCodeUnits(left: string, right: string): -1 | 0 | 1 {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/** Copy and deterministically order the failed collectors for a partial host. */
function projectFailedCollectors(observedHost: ObservedHost | undefined): CollectorFailureProjection[] {
  const failed = observedHost?.collectors?.failed ?? [];
  const copied: CollectorFailureProjection[] = [];
  for (const entry of failed) {
    assertInput(isPlainObject(entry));
    assertInput(typeof entry.name === "string" && typeof entry.reason === "string");
    copied.push({ name: entry.name, reason: entry.reason });
  }
  copied.sort((left, right) => {
    const byFolded = compareCodeUnits(left.name.toLowerCase(), right.name.toLowerCase());
    if (byFolded !== 0) return byFolded;
    const byName = compareCodeUnits(left.name, right.name);
    if (byName !== 0) return byName;
    return compareCodeUnits(left.reason, right.reason);
  });
  return copied;
}

/** Copy the four freshness fields into an independently owned record. */
function copyFreshness(freshness: FreshnessStamp): FreshnessStamp {
  return {
    state: freshness.state,
    observedAt: freshness.observedAt,
    ageMs: freshness.ageMs,
    ttlMs: freshness.ttlMs,
  };
}

/** Copy the provider read error, preserving the optional HTTP status. */
function copyReadError(readError: SnapshotReadError | null): SnapshotReadError | null {
  if (readError === null || readError === undefined) return null;
  assertInput(isPlainObject(readError));
  assertInput(typeof readError.code === "string" && typeof readError.message === "string");
  const copy: SnapshotReadError = { code: readError.code, message: readError.message };
  if (readError.httpStatus !== undefined) {
    assertInput(typeof readError.httpStatus === "number");
    copy.httpStatus = readError.httpStatus;
  }
  return copy;
}

/** Recursively freeze every owned object and array; cycle-safe by construction. */
function deepFreeze<T>(value: T, seen: Set<object>): T {
  if (value === null || typeof value !== "object") return value;
  const object = value as unknown as object;
  if (seen.has(object)) return value;
  seen.add(object);
  for (const key of Object.keys(object)) {
    deepFreeze((object as Record<string, unknown>)[key], seen);
  }
  Object.freeze(object);
  return value;
}

/**
 * Derive one complete immutable drift-and-coverage view from one available
 * snapshot-provider generation at an explicit display clock.
 *
 * @param envelope - Available whole snapshot-provider envelope to project.
 * @param now - Clock used for waiver status and host collection age.
 * @returns Findings, coverage rows, provider metadata, and summary from the
 * same input generation.
 * @throws {DriftProjectionError} With `INVALID_CLOCK` for a non-finite Date,
 * `INVALID_INPUT` for an unavailable or structurally impossible generation,
 * or `DERIVATION_FAILED` for an unexpected internal failure.
 */
export function deriveDriftProjection(
  envelope: Readonly<ProviderEnvelope<SnapshotProviderResult>>,
  now: Date,
): DriftProjection {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new DriftProjectionError("INVALID_CLOCK", "Projection clock must be a valid Date.");
  }
  const nowMs = now.getTime();
  const derivedAt = now.toISOString();

  try {
    assertInput(isPlainObject(envelope));
    assertInput(isPlainObject(envelope.freshness));
    assertInput(isPlainObject(envelope.data));

    const data = envelope.data as SnapshotProviderResult;
    assertInput(isPlainObject(data.snapshot));
    assertInput(isPlainObject(data.hostStates));
    assertInput(typeof data.snapshot.generatedAt === "string");
    assertInput(typeof data.lastReadAt === "string");

    const snapshot = data.snapshot;
    assertInput(snapshot.drift === undefined || Array.isArray(snapshot.drift));
    assertInput(snapshot.hosts === undefined || Array.isArray(snapshot.hosts));

    // Findings: project every snapshot.drift entry exactly once, grouped host then service.
    const groups = new Map<string, Map<string | null, DriftFindingProjection[]>>();
    const activeSeverity: SeverityCounter = { error: 0, warning: 0, info: 0 };
    let activeWaivers = 0;
    let expiredWaivers = 0;
    let totalFindings = 0;

    const sourceFindings = snapshot.drift ?? [];
    for (const source of sourceFindings) {
      const finding = projectFinding(source, nowMs);
      let subgroupMap = groups.get(finding.host);
      if (!subgroupMap) {
        subgroupMap = new Map<string | null, DriftFindingProjection[]>();
        groups.set(finding.host, subgroupMap);
      }
      let bucket = subgroupMap.get(finding.service);
      if (!bucket) {
        bucket = [];
        subgroupMap.set(finding.service, bucket);
      }
      bucket.push(finding);

      totalFindings += 1;
      if (finding.waiverState === "active") {
        activeWaivers += 1;
      } else {
        if (finding.waiverState === "expired") expiredWaivers += 1;
        activeSeverity[finding.severity] += 1;
      }
    }

    const findingGroups = buildFindingGroups(groups);

    // Coverage: one row per hostStates key, using the first observed host for collectors.
    const observedByName = new Map<string, ObservedHost>();
    for (const host of snapshot.hosts ?? []) {
      assertInput(isPlainObject(host) && typeof host.name === "string");
      if (!observedByName.has(host.name)) observedByName.set(host.name, host as ObservedHost);
    }

    const coverage: CoverageCounter = {
      fresh: 0,
      stale: 0,
      partial: 0,
      unreachable: 0,
      "never-collected": 0,
    };
    const coverageRows: CoverageRow[] = [];
    let totalHosts = 0;

    for (const [host, state] of Object.entries(data.hostStates)) {
      assertInput(isPlainObject(state));
      assertInput(typeof state.state === "string" && COVERAGE_STATES.has(state.state));
      assertInput(typeof state.pastStaleThreshold === "boolean");
      assertInput(state.collectedAt === null || typeof state.collectedAt === "string");

      let collectedAt: string | null = null;
      let ageMs: number | null = null;
      if (typeof state.collectedAt === "string") {
        const epoch = parseRfc3339(state.collectedAt);
        assertInput(epoch !== null);
        collectedAt = state.collectedAt;
        ageMs = Math.max(0, nowMs - epoch);
      }

      const failedCollectors =
        state.state === "partial" ? projectFailedCollectors(observedByName.get(host)) : [];

      coverageRows.push({
        host,
        state: state.state,
        collectedAt,
        ageMs,
        pastStaleThreshold: state.pastStaleThreshold,
        failedCollectors,
      });

      totalHosts += 1;
      coverage[state.state] += 1;
    }

    coverageRows.sort(compareCoverageRows);

    const projection: DriftProjection = {
      snapshotGeneratedAt: snapshot.generatedAt,
      providerObservedAt: envelope.freshness.observedAt,
      providerFreshness: copyFreshness(envelope.freshness),
      lastSuccessfulReadAt: data.lastReadAt,
      readError: copyReadError(data.readError),
      derivedAt,
      summary: {
        activeSeverity,
        coverage,
        activeWaivers,
        expiredWaivers,
        totalFindings,
        totalHosts,
      },
      findingGroups,
      coverageRows,
    };

    return deepFreeze(projection, new Set<object>());
  } catch (error) {
    if (error instanceof DriftProjectionError) throw error;
    throw new DriftProjectionError("DERIVATION_FAILED", "Drift projection could not be derived.", {
      cause: error,
    });
  }
}
