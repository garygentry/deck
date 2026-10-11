import type {
  DeckConfigDocument,
  DriftFinding,
  Host,
  JsonValue,
  ObservedHost,
  SnapshotDocument,
  Service,
  Waiver,
} from "@deck/schema";
import type {
  HostCollectionState,
  HostState,
  ProviderEnvelope,
  SnapshotProviderResult,
} from "@deck/contract";

/**
 * Deterministic invented scale factories for the drift-and-coverage performance
 * and above-scale reachability gates. Every identity is invented under the
 * `fixture-*` namespace with RFC 6761 `.invalid` hosts; nothing here copies
 * estate facts and nothing is production-exported.
 *
 * The two exported builders are browser/server neutral: their dependency graph
 * is only `@deck/schema` and `@deck/server` type imports plus standard
 * ECMAScript, so a server test may either import them or mirror their signatures
 * without reversing the production package dependency direction.
 */

/** Fixed test clock; tests advance it explicitly and never depend on wall time. */
export const DRIFT_FIXTURE_NOW = "2035-01-15T12:00:00.000Z";

/** Fixed epoch of {@link DRIFT_FIXTURE_NOW} used to derive deterministic ages. */
const NOW_MS = Date.parse(DRIFT_FIXTURE_NOW);

/** The five authoritative coverage states cycled across scale hosts. */
const COVERAGE_STATES: readonly HostCollectionState[] = [
  "fresh",
  "stale",
  "partial",
  "unreachable",
  "never-collected",
];

/** Closed severity vocabulary cycled across scale findings. */
const SEVERITIES = ["error", "warning", "info"] as const;

/** Open category strings cycled across scale findings. */
const CATEGORIES = [
  "fixture.config",
  "fixture.package",
  "fixture.service",
  "fixture.network",
  "fixture.evidence",
] as const;

/** Zero-padded stable index used for deterministic ids. */
function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

/** Deterministic RFC 3339 timestamp `offsetMs` before the fixed clock. */
function beforeNow(offsetMs: number): string {
  return new Date(NOW_MS - offsetMs).toISOString();
}

/** One invented declared host used only for inventory-model construction. */
function declaredHost(name: string): Host {
  return {
    name,
    kind: "vm",
    purpose: "Invented scale-fixture host.",
  };
}

/** One invented declared service on `host`. */
function declaredService(host: string, name: string): Service {
  return {
    name,
    host,
    kind: "docker-compose",
    purpose: "Invented scale-fixture service.",
  };
}

/** The two invented service names owned by the host at `hostIndex`. */
function serviceNames(hostIndex: number): readonly [string, string] {
  const suffix = pad(hostIndex, 3);
  return [`fixture-service-${suffix}-a`, `fixture-service-${suffix}-b`];
}

/** Build one invented waiver in the requested display-time state. */
function waiverFor(kind: "active" | "expired", id: string): Waiver {
  return {
    reason: `Invented waiver for ${id}.`,
    who: "fixture-operator",
    until: kind === "active" ? "2099-01-01T00:00:00.000Z" : "2020-01-01T00:00:00.000Z",
  };
}

/** Options steering a deterministic finding distribution. */
interface FindingPlan {
  /** Zero-based finding ordinal used for stable ids and cycling. */
  readonly ordinal: number;
  /** Exact host identity. */
  readonly host: string;
  /** Optional exact service identity; absent means a host-level finding. */
  readonly service?: string;
  /** Optional bounded large evidence for above-scale responsiveness checks. */
  readonly largeEvidence?: boolean;
}

/** Build one schema-shaped invented drift finding from a deterministic plan. */
function planFinding(plan: FindingPlan): DriftFinding {
  const id = `fixture-finding-${pad(plan.ordinal, 4)}`;
  const severity = SEVERITIES[plan.ordinal % SEVERITIES.length]!;
  const waiverKind = plan.ordinal % 3;

  const finding: DriftFinding = {
    id,
    severity,
    location:
      plan.service === undefined
        ? { host: plan.host }
        : { host: plan.host, service: plan.service },
    category: CATEGORIES[plan.ordinal % CATEGORIES.length]!,
    message: `Invented drift ${id}.`,
    expected: plan.largeEvidence ? largeEvidence(plan.ordinal) : { value: plan.ordinal },
    observed: plan.largeEvidence ? largeEvidence(plan.ordinal + 1) : { value: plan.ordinal + 1 },
  };

  if (waiverKind === 1) finding.waiver = waiverFor("active", id);
  else if (waiverKind === 2) finding.waiver = waiverFor("expired", id);

  return finding;
}

/** Deterministic bounded evidence: a fixed-size nested structure, never unbounded. */
function largeEvidence(seed: number): JsonValue {
  const rows: JsonValue[] = [];
  for (let index = 0; index < 40; index += 1) {
    rows.push({ index, note: `bounded-${(seed + index) % 97}` });
  }
  return { kind: "bounded-large", rows };
}

/** Build one authoritative host-state record for a coverage state. */
function hostStateFor(state: HostCollectionState): HostState {
  switch (state) {
    case "fresh":
      return { state, collectedAt: beforeNow(60_000), ageMs: 60_000, pastStaleThreshold: false };
    case "stale":
      return { state, collectedAt: beforeNow(8_640_000_000), ageMs: 8_640_000_000, pastStaleThreshold: true };
    case "partial":
      return { state, collectedAt: beforeNow(7_200_000), ageMs: 7_200_000, pastStaleThreshold: false };
    case "unreachable":
      return { state, collectedAt: null, ageMs: null, pastStaleThreshold: false };
    case "never-collected":
      return { state, collectedAt: null, ageMs: null, pastStaleThreshold: false };
  }
}

/** Build the observed host carrying deterministic partial-collector failures. */
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

/** Build the available provider envelope wrapping one invented snapshot. */
function envelopeFor(
  snapshot: SnapshotDocument,
  hostStates: Readonly<Record<string, HostState>>,
): ProviderEnvelope<SnapshotProviderResult> {
  return {
    id: "snapshot",
    kind: "snapshot",
    freshness: {
      state: "fresh",
      observedAt: DRIFT_FIXTURE_NOW,
      ageMs: 0,
      ttlMs: 30_000,
    },
    data: {
      snapshot,
      findings: [],
      hostStates,
      lastReadAt: DRIFT_FIXTURE_NOW,
      readError: null,
    },
    error: null,
  };
}

/**
 * Generate a valid population strictly larger than every required scale
 * dimension, with a concentrated finding subgroup and coverage population both
 * greater than 25 rows for progressive-disclosure reachability checks. It does
 * not benchmark an unbounded maximum or imply support for infinite input.
 */
export function buildAboveScaleFixture(): Readonly<{
  /** At least 151 hosts. */
  readonly hostCount: number;
  /** At least 301 services. */
  readonly serviceCount: number;
  /** At least 1,001 findings. */
  readonly findingCount: number;
  /** Matching invented config used to construct the real inventory model. */
  readonly config: DeckConfigDocument;
  /** Matching complete provider envelope. */
  readonly envelope: ProviderEnvelope<SnapshotProviderResult>;
}> {
  const hostCount = 160;
  const hosts: Host[] = [];
  const services: Service[] = [];
  const hostStates: Record<string, HostState> = {};
  const observedHosts: ObservedHost[] = [];

  for (let index = 0; index < hostCount; index += 1) {
    const host = `fixture-host-${pad(index, 3)}.invalid`;
    hosts.push(declaredHost(host));

    const [serviceA, serviceB] = serviceNames(index);
    services.push(declaredService(host, serviceA), declaredService(host, serviceB));

    const state = COVERAGE_STATES[index % COVERAGE_STATES.length]!;
    hostStates[host] = hostStateFor(state);
    if (state === "partial") observedHosts.push(partialObservedHost(host));
  }

  const firstHost = `fixture-host-${pad(0, 3)}.invalid`;
  const [firstServiceA] = serviceNames(0);

  const drift: DriftFinding[] = [];
  let ordinal = 0;

  // Concentrate 30 (> 25) findings in one host/service subgroup for show-more/show-all.
  for (let index = 0; index < 30; index += 1, ordinal += 1) {
    drift.push(
      planFinding({
        ordinal,
        host: firstHost,
        service: firstServiceA,
        largeEvidence: index === 0,
      }),
    );
  }

  // Distribute the remaining findings across the estate for a total above scale.
  const remaining = 1010 - drift.length;
  for (let index = 0; index < remaining; index += 1, ordinal += 1) {
    const hostIndex = (index + 1) % hostCount;
    const host = `fixture-host-${pad(hostIndex, 3)}.invalid`;
    const [serviceA, serviceB] = serviceNames(hostIndex);
    const placement = ordinal % 3;
    const service = placement === 0 ? undefined : placement === 1 ? serviceA : serviceB;
    drift.push(planFinding({ ordinal, host, service }));
  }

  const snapshot: SnapshotDocument = {
    schemaVersion: 1,
    generatedAt: DRIFT_FIXTURE_NOW,
    hosts: observedHosts,
    drift,
  };

  const config: DeckConfigDocument = {
    schemaVersion: 2,
    estate: { name: "Fixture Estate (above scale)" },
    hosts,
    services,
  };

  // Assert strictly-above-scale cardinalities and the reachability minimums.
  if (Object.keys(hostStates).length <= 150) {
    throw new RangeError("Above-scale fixture must expose more than 150 host states.");
  }
  if (services.length <= 300) {
    throw new RangeError("Above-scale fixture must expose more than 300 services.");
  }
  if (drift.length <= 1000) {
    throw new RangeError("Above-scale fixture must expose more than 1000 findings.");
  }

  return {
    hostCount,
    serviceCount: services.length,
    findingCount: drift.length,
    config,
    envelope: envelopeFor(snapshot, hostStates),
  };
}
