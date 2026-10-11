import { describe, expect, it } from "vitest";

// `../src/index.js` is the `@deck/drift` public entry point (package.json `exports["."]`).
import {
  deriveDriftProjection,
  driftServiceFacetKey,
  filterDriftProjection,
} from "../src/index.js";
import type {
  DriftFilters,
  DriftProjection,
} from "../src/index.js";
import type {
  HostCollectionState,
  HostState,
  ProviderEnvelope,
  SnapshotProviderResult,
} from "@deck/contract";
import type { DriftFinding, ObservedHost, SnapshotDocument, Waiver } from "@deck/schema";

// This suite mirrors the deterministic scale factory published for the web
// workspace (`apps/web/test/drift-fixtures.ts`). Importing that file here would
// reverse the package dependency direction — and its `@deck/server` specifier
// cannot self-resolve inside the server package — so the same signature is
// mirrored locally with server-relative types. Every identity is invented under
// the `fixture-*` namespace with RFC 6761 `.invalid` hosts.

const DRIFT_FIXTURE_NOW = "2035-01-15T12:00:00.000Z";
const NOW = new Date(DRIFT_FIXTURE_NOW);
const NOW_MS = NOW.getTime();

const COVERAGE_STATES: readonly HostCollectionState[] = [
  "fresh",
  "stale",
  "partial",
  "unreachable",
  "never-collected",
];
const SEVERITIES = ["error", "warning", "info"] as const;
const CATEGORIES = [
  "fixture.config",
  "fixture.package",
  "fixture.service",
  "fixture.network",
  "fixture.evidence",
] as const;

/** Server-local scale fixture; mirrors `DriftScaleFixture` without web imports. */
interface ServerScaleFixture {
  readonly hostCount: 150;
  readonly serviceCount: 300;
  readonly findingCount: 1000;
  readonly snapshot: SnapshotDocument;
  readonly envelope: ProviderEnvelope<SnapshotProviderResult>;
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

function beforeNow(offsetMs: number): string {
  return new Date(NOW_MS - offsetMs).toISOString();
}

/** Small deterministic PRNG (mulberry32) driving the seeded input permutation. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function permute<T>(items: T[], seed: number): T[] {
  const random = mulberry32(seed);
  for (let index = items.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    const temporary = items[index]!;
    items[index] = items[swap]!;
    items[swap] = temporary;
  }
  return items;
}

function serviceNames(hostIndex: number): readonly [string, string] {
  const suffix = pad(hostIndex, 3);
  return [`fixture-service-${suffix}-a`, `fixture-service-${suffix}-b`];
}

function waiverFor(kind: "active" | "expired", id: string): Waiver {
  return {
    reason: `Invented waiver for ${id}.`,
    who: "fixture-operator",
    until: kind === "active" ? "2099-01-01T00:00:00.000Z" : "2020-01-01T00:00:00.000Z",
  };
}

function planFinding(ordinal: number, host: string, service: string | undefined): DriftFinding {
  const id = `fixture-finding-${pad(ordinal, 4)}`;
  const finding: DriftFinding = {
    id,
    severity: SEVERITIES[ordinal % SEVERITIES.length]!,
    location: service === undefined ? { host } : { host, service },
    category: CATEGORIES[ordinal % CATEGORIES.length]!,
    message: `Invented drift ${id}.`,
    expected: { value: ordinal },
    observed: { value: ordinal + 1 },
  };
  const waiverKind = ordinal % 3;
  if (waiverKind === 1) finding.waiver = waiverFor("active", id);
  else if (waiverKind === 2) finding.waiver = waiverFor("expired", id);
  return finding;
}

function hostStateFor(state: HostCollectionState): HostState {
  switch (state) {
    case "fresh":
      return { state, collectedAt: beforeNow(60_000), ageMs: 60_000, pastStaleThreshold: false };
    case "stale":
      return { state, collectedAt: beforeNow(8_640_000_000), ageMs: 8_640_000_000, pastStaleThreshold: true };
    case "partial":
      return { state, collectedAt: beforeNow(7_200_000), ageMs: 7_200_000, pastStaleThreshold: false };
    default:
      return { state, collectedAt: null, ageMs: null, pastStaleThreshold: false };
  }
}

function partialObservedHost(name: string): ObservedHost {
  return {
    name,
    coverage: "partial",
    collectedAt: beforeNow(7_200_000),
    collectors: {
      succeeded: ["fixture-collector-ok"],
      failed: [
        { name: "fixture-collector-x", reason: "Invented collector failure x." },
        { name: "fixture-collector-y", reason: "Invented collector failure y." },
      ],
    },
  };
}

function buildScaleFixture(seed = 0): ServerScaleFixture {
  if (!Number.isSafeInteger(seed)) {
    throw new RangeError("Scale fixture seed must be a safe integer.");
  }

  const hostCount = 150;
  const hostStates: Record<string, HostState> = {};
  const observedHosts: ObservedHost[] = [];
  let serviceCount = 0;

  for (let index = 0; index < hostCount; index += 1) {
    const host = `fixture-host-${pad(index, 3)}.invalid`;
    serviceCount += serviceNames(index).length;
    const state = COVERAGE_STATES[index % COVERAGE_STATES.length]!;
    hostStates[host] = hostStateFor(state);
    if (state === "partial") observedHosts.push(partialObservedHost(host));
  }

  const drift: DriftFinding[] = [];
  for (let ordinal = 0; ordinal < 1000; ordinal += 1) {
    const hostIndex = ordinal % hostCount;
    const host = `fixture-host-${pad(hostIndex, 3)}.invalid`;
    const [serviceA, serviceB] = serviceNames(hostIndex);
    const placement = ordinal % 3;
    const service = placement === 0 ? undefined : placement === 1 ? serviceA : serviceB;
    drift.push(planFinding(ordinal, host, service));
  }
  permute(drift, seed);

  const snapshot: SnapshotDocument = {
    schemaVersion: 1,
    generatedAt: DRIFT_FIXTURE_NOW,
    hosts: observedHosts,
    drift,
  };

  const envelope: ProviderEnvelope<SnapshotProviderResult> = {
    id: "snapshot",
    kind: "snapshot",
    freshness: { state: "fresh", observedAt: DRIFT_FIXTURE_NOW, ageMs: 0, ttlMs: 30_000 },
    data: {
      snapshot,
      findings: [],
      hostStates,
      lastReadAt: DRIFT_FIXTURE_NOW,
      readError: null,
    },
    error: null,
  };

  if (Object.keys(hostStates).length !== 150) {
    throw new RangeError("Scale fixture must expose exactly 150 host states.");
  }
  if (serviceCount !== 300) {
    throw new RangeError("Scale fixture must expose exactly 300 services.");
  }
  if (drift.length !== 1000) {
    throw new RangeError("Scale fixture must expose exactly 1000 findings.");
  }

  return { hostCount: 150, serviceCount: 300, findingCount: 1000, snapshot, envelope };
}

// Pure-operation budgets from the testing strategy: a derive/update stays within
// the one-second page budget, a filter within the 100 ms interaction budget.
// This suite is a diagnostic tripwire inside those budgets, not the Chromium
// complete-page gate.
const DERIVE_BUDGET_MS = 1_000;
const FILTER_BUDGET_MS = 100;
const SAMPLE_COUNT = 3;

/** Monotonic high-resolution clock; never wall time. */
const clock = (): number => performance.now();

/** Count how many drift array elements carry a given source severity. */
function countBySeverity(drift: readonly DriftFinding[], severity: string): number {
  let total = 0;
  for (const finding of drift) if (finding.severity === severity) total += 1;
  return total;
}

/** Build a filter selecting exactly one severity facet. */
function severityFilter(severity: "error" | "warning" | "info"): DriftFilters {
  return {
    text: "",
    severities: new Set([severity]),
    hosts: new Set<string>(),
    services: new Set<string>(),
    categories: new Set<string>(),
    waiverStates: new Set(),
    coverageHosts: new Set<string>(),
    coverageStates: new Set(),
  };
}

/** Build a filter with no active criteria (all rows pass). */
function passthroughFilter(): DriftFilters {
  return {
    text: "",
    severities: new Set(),
    hosts: new Set<string>(),
    services: new Set<string>(),
    categories: new Set<string>(),
    waiverStates: new Set(),
    coverageHosts: new Set<string>(),
    coverageStates: new Set(),
  };
}

/** Total surviving findings across a filtered projection's returned references. */
function countFindings(result: { findingGroups: DriftProjection["findingGroups"] }): number {
  let total = 0;
  for (const group of result.findingGroups) {
    for (const subgroup of group.subgroups) total += subgroup.findings.length;
  }
  return total;
}

describe("pure drift derivation performance at exact CI scale", () => {
  it("asserts the exact 150/300/1,000 population before timing", () => {
    const fixture = buildScaleFixture();
    expect(Object.keys(fixture.envelope.data!.hostStates)).toHaveLength(150);
    expect(fixture.serviceCount).toBe(300);
    expect(fixture.envelope.data!.snapshot.drift).toHaveLength(1000);
  });

  it("rejects a non-safe-integer seed with the fixed RangeError", () => {
    expect(() => buildScaleFixture(1.5)).toThrow(RangeError);
    expect(() => buildScaleFixture(1.5)).toThrow("Scale fixture seed must be a safe integer.");
  });

  it("derives within the page budget across one warm-up and three valid samples", () => {
    const fixture = buildScaleFixture();

    // Unmeasured warm-up.
    const warm = deriveDriftProjection(fixture.envelope, NOW);
    expect(warm.summary.totalFindings).toBe(1000);
    expect(warm.summary.totalHosts).toBe(150);

    const durations: number[] = [];
    for (let sample = 0; sample < SAMPLE_COUNT; sample += 1) {
      const start = clock();
      const projection = deriveDriftProjection(fixture.envelope, NOW);
      const end = clock();

      const duration = end - start;
      // A sample is invalid — and fails, never discarded — on wrong cardinality.
      expect(Number.isFinite(duration)).toBe(true);
      expect(duration).toBeGreaterThanOrEqual(0);
      expect(projection.summary.totalFindings).toBe(1000);
      expect(projection.summary.totalHosts).toBe(150);
      expect(countFindings(projection)).toBe(1000);
      expect(projection.coverageRows).toHaveLength(150);
      durations.push(duration);
    }

    console.info("drift.performance.derive", {
      samples: durations,
      fastestMs: Math.min(...durations),
      findingCount: 1000,
      hostCount: 150,
    });
    expect(Math.min(...durations)).toBeLessThan(DERIVE_BUDGET_MS);
  });
});

describe("pure drift filtering performance at exact CI scale", () => {
  it("filters within the interaction budget across one warm-up and three valid samples", () => {
    const fixture = buildScaleFixture();
    const projection = deriveDriftProjection(fixture.envelope, NOW);
    const filters = severityFilter("error");
    const expectedErrors = countBySeverity(fixture.envelope.data!.snapshot.drift ?? [], "error");
    expect(expectedErrors).toBeGreaterThan(0);

    // Unmeasured warm-up.
    const warm = filterDriftProjection(projection, filters);
    expect(warm.total).toBe(projection.summary);
    expect(countFindings(warm)).toBe(expectedErrors);

    const durations: number[] = [];
    for (let sample = 0; sample < SAMPLE_COUNT; sample += 1) {
      const start = clock();
      const result = filterDriftProjection(projection, filters);
      const end = clock();

      const duration = end - start;
      expect(Number.isFinite(duration)).toBe(true);
      expect(duration).toBeGreaterThanOrEqual(0);
      // Complete totals are retained; only the filtered population narrows.
      expect(result.source).toBe(projection);
      expect(result.total).toBe(projection.summary);
      expect(result.hasActiveFilters).toBe(true);
      expect(countFindings(result)).toBe(expectedErrors);
      expect(result.filtered.findings).toBe(expectedErrors);
      expect(result.coverageRows).toHaveLength(150);
      durations.push(duration);
    }

    console.info("drift.performance.filter", {
      samples: durations,
      fastestMs: Math.min(...durations),
      filteredFindingCount: expectedErrors,
      coverageRowCount: 150,
    });
    expect(Math.min(...durations)).toBeLessThan(FILTER_BUDGET_MS);
  });

  it("passthrough filtering retains the complete generation population", () => {
    const fixture = buildScaleFixture();
    const projection = deriveDriftProjection(fixture.envelope, NOW);

    // Unmeasured warm-up.
    filterDriftProjection(projection, passthroughFilter());

    const durations: number[] = [];
    for (let sample = 0; sample < SAMPLE_COUNT; sample += 1) {
      const start = clock();
      const result = filterDriftProjection(projection, passthroughFilter());
      const end = clock();

      const duration = end - start;
      expect(Number.isFinite(duration)).toBe(true);
      expect(duration).toBeGreaterThanOrEqual(0);
      expect(result.hasActiveFilters).toBe(false);
      expect(countFindings(result)).toBe(1000);
      expect(result.filtered.findings).toBe(1000);
      expect(result.coverageRows).toHaveLength(150);
      durations.push(duration);
    }

    console.info("drift.performance.filter.passthrough", {
      samples: durations,
      fastestMs: Math.min(...durations),
      filteredFindingCount: 1000,
      coverageRowCount: 150,
    });
    expect(Math.min(...durations)).toBeLessThan(FILTER_BUDGET_MS);
  });
});

describe("service facet keys remain deterministic at scale", () => {
  it("produces the collision-free JSON tuple encoding", () => {
    expect(driftServiceFacetKey({ host: "fixture-host-000.invalid", service: "fixture-service-000-a" })).toBe(
      JSON.stringify(["fixture-host-000.invalid", "fixture-service-000-a"]),
    );
  });
});
