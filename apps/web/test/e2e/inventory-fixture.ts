import type {
  DeckConfigDocument,
  ObservedHost,
  ObservedService,
  SnapshotDocument,
} from "@deck/schema";

/**
 * Invented, estate-fact-free inventory scenario for the Chromium E2E suite.
 *
 * One config/snapshot pair encodes every observable inventory distinction the
 * core scenarios assert against the real Bun API + Vite harness: the five host
 * collection states (fresh, stale, partial, unreachable, never-collected),
 * undeclared and hidden entities, a service name duplicated across two hosts,
 * every named host/service detail field, and an identity that must be encoded as
 * one route segment. Names live under the RFC 6761 `.invalid` namespace and the
 * `fixture-` prefix; there are no real hostnames, domains, addresses, or secret
 * values. Secret references are ids only (schema `SecretRef` pattern), and the
 * forbidden-secret sentinel below is never written into any document so a normal
 * rendered-output scan can prove it never surfaces.
 */

/** Stable identities and sentinels shared by the API helper and the spec. */
export const FIXTURE = Object.freeze({
  estateName: "Fixture inventory estate",

  /** Declared + observed rich detail host; also the fresh collection example. */
  hostAlpha: "fixture-host-alpha",
  /** Declared + observed, collected past the 24h default threshold (stale). */
  hostBravo: "fixture-host-bravo",
  /** Declared + observed with partial coverage and collector outcomes. */
  hostCharlie: "fixture-host-charlie",
  /** Declared + observed unreachable (no collection timestamp). */
  hostDelta: "fixture-host-delta",
  /** Declared only, absent from the snapshot (never collected). */
  hostEcho: "fixture-host-echo",
  /** Declared hidden, still collected and marked. */
  hostFoxtrot: "fixture-host-foxtrot",
  /** Observed only, absent from the config (undeclared). */
  hostGolf: "fixture-host-golf",
  /** Identity that must be encoded independently as one route segment. */
  hostEncoded: "fixture-host encoded/name",

  /** Declared + observed service; the name is duplicated on bravo. */
  serviceWeb: "web",
  /** Declared service with no observation under an available snapshot. */
  serviceDb: "db",
  /** Observed only, undeclared service on a declared host. */
  serviceGhost: "ghost",
  /** Declared hidden service. */
  serviceCache: "cache",
  /** Observed only, undeclared service on the undeclared host. */
  serviceGolfOnly: "only",
  /** Service identity that must be encoded independently as one route segment. */
  serviceEncoded: "svc encoded/name",

  /** Secret reference ids that must be visibly rendered where declared. */
  secretIds: Object.freeze([
    "fixture-secret-token",
    "fixture.secret.apikey",
    "fixture-secret-web",
  ]),
  /** Sentinel secret value that must never appear in any rendered output. */
  forbiddenSecretValue: "FORBIDDEN-SECRET-VALUE-must-not-render",
  /** A visible open fact value used to prove observed facts render. */
  observedFactValue: "alpha-observed-fact-value",
} as const);

/**
 * A presentation overlay layer merged onto the base inventory config.
 *
 * Presentation-owned keys (`links`, `hidden`) may not appear in a base layer, so
 * they live here keyed by host/service identity and are merged by the loader.
 */
export interface InventoryOverlayDocument {
  schemaVersion: 1;
  hosts?: { name: string; links?: { title: string; href: string }[]; hidden?: boolean }[];
  services?: {
    host: string;
    name: string;
    links?: { title: string; href: string }[];
    hidden?: boolean;
  }[];
}

/**
 * Build the one invented config/snapshot generation.
 *
 * @param nowMs - Wall-clock epoch used to place collection timestamps so the
 * server derives fresh, stale, and partial states deterministically at poll time.
 */
export function buildInventoryScenario(nowMs: number): {
  config: DeckConfigDocument;
  overlay: InventoryOverlayDocument;
  snapshot: SnapshotDocument;
} {
  const freshIso = new Date(nowMs).toISOString();
  const staleIso = new Date(nowMs - 25 * 60 * 60 * 1000).toISOString();
  const generatedAt = freshIso;

  const config: DeckConfigDocument = {
    schemaVersion: 1,
    estate: { name: FIXTURE.estateName },
    hosts: [
      {
        name: FIXTURE.hostAlpha,
        kind: "vm",
        purpose: "Alpha rich detail host",
        hypervisor: FIXTURE.hostCharlie,
        vmid: 100,
        addresses: [
          { network: "lan", address: "10.10.0.10", primary: true },
          { network: "mgmt", address: "10.20.0.10" },
        ],
        access: {
          reachable: true,
          method: "ssh",
          port: 22,
          user: "deploy",
          sudo: true,
          notes: "Access via bastion.",
        },
        backup: {
          expected: true,
          schedule: "Nightly 02:00",
          target: "backup-vault.invalid",
          notes: "Retained 30 days.",
        },
        managedConfigs: [
          { path: "/etc/app/app.conf", source: "repo://app/app.conf", notes: "Primary config." },
          { path: "/etc/app/only-declared.conf", source: "repo://app/extra.conf" },
        ],
        secrets: ["fixture-secret-token", "fixture.secret.apikey"],
      },
      { name: FIXTURE.hostBravo, kind: "bare-metal", purpose: "Bravo stale host" },
      { name: FIXTURE.hostCharlie, kind: "lxc", purpose: "Charlie partial host" },
      { name: FIXTURE.hostDelta, kind: "appliance", purpose: "Delta unreachable host" },
      { name: FIXTURE.hostEcho, kind: "endpoint", purpose: "Echo never-collected host" },
      { name: FIXTURE.hostFoxtrot, kind: "vm", purpose: "Foxtrot hidden host" },
      { name: FIXTURE.hostEncoded, kind: "unknown", purpose: "Encoded-identity host" },
    ],
    services: [
      {
        name: FIXTURE.serviceWeb,
        host: FIXTURE.hostAlpha,
        kind: "docker-compose",
        purpose: "Alpha web service",
        status: "active",
        stack: "web-stack",
        secrets: ["fixture-secret-web"],
        backup: { expected: true, schedule: "Weekly" },
      },
      { name: FIXTURE.serviceDb, host: FIXTURE.hostAlpha, kind: "systemd", purpose: "Alpha database" },
      { name: FIXTURE.serviceWeb, host: FIXTURE.hostBravo, kind: "container", purpose: "Bravo web service" },
      {
        name: FIXTURE.serviceCache,
        host: FIXTURE.hostFoxtrot,
        kind: "container",
        purpose: "Foxtrot hidden service",
      },
      {
        name: FIXTURE.serviceEncoded,
        host: FIXTURE.hostEncoded,
        kind: "external",
        purpose: "Encoded-identity service",
      },
    ],
  };

  // Presentation overlay: links and hidden markers keyed by identity.
  const overlay: InventoryOverlayDocument = {
    schemaVersion: 1,
    hosts: [
      { name: FIXTURE.hostAlpha, links: [{ title: "Alpha dashboard", href: "https://alpha.dashboard.invalid/" }] },
      { name: FIXTURE.hostFoxtrot, hidden: true },
    ],
    services: [
      { host: FIXTURE.hostAlpha, name: FIXTURE.serviceWeb, links: [{ title: "Web UI", href: "https://web.invalid/" }] },
      { host: FIXTURE.hostFoxtrot, name: FIXTURE.serviceCache, hidden: true },
    ],
  };

  const snapshot: SnapshotDocument = {
    schemaVersion: 1,
    generatedAt,
    hosts: [
      {
        name: FIXTURE.hostAlpha,
        coverage: "collected",
        collectedAt: freshIso,
        reachable: true,
        addresses: [
          { network: "lan", address: "10.10.0.10", primary: true },
          { network: "vpn", address: "10.30.0.10" },
        ],
        os: { name: "FixtureOS", version: "9.9", kernel: "6.1.0-fixture" },
        uptimeSeconds: 0,
        containers: [{ name: "alpha-app", image: "registry.invalid/app:1.0", state: "running" }],
        guests: [{ vmid: 100, name: "alpha-guest", state: "running" }],
        managedConfigs: [
          { path: "/etc/app/app.conf", inSync: true },
          { path: "/etc/app/only-observed.conf", inSync: false },
        ],
        facts: { "alpha.fact": FIXTURE.observedFactValue, "zeta.fact": 123 },
      },
      { name: FIXTURE.hostBravo, coverage: "collected", collectedAt: staleIso, reachable: true },
      {
        name: FIXTURE.hostCharlie,
        coverage: "partial",
        collectedAt: freshIso,
        reachable: true,
        collectors: {
          succeeded: ["os", "network"],
          failed: [{ name: "docker", reason: "Docker socket timeout" }],
        },
      },
      { name: FIXTURE.hostDelta, coverage: "unreachable", reachable: false },
      { name: FIXTURE.hostFoxtrot, coverage: "collected", collectedAt: freshIso, reachable: true },
      { name: FIXTURE.hostGolf, coverage: "collected", collectedAt: freshIso, reachable: true },
      { name: FIXTURE.hostEncoded, coverage: "collected", collectedAt: freshIso, reachable: true },
    ],
    services: [
      { host: FIXTURE.hostAlpha, name: FIXTURE.serviceWeb, state: "running", facts: { "web.fact": "web-visible" } },
      { host: FIXTURE.hostAlpha, name: FIXTURE.serviceGhost, state: "degraded" },
      { host: FIXTURE.hostBravo, name: FIXTURE.serviceWeb, state: "running" },
      { host: FIXTURE.hostFoxtrot, name: FIXTURE.serviceCache, state: "running" },
      { host: FIXTURE.hostGolf, name: FIXTURE.serviceGolfOnly, state: "unknown" },
      { host: FIXTURE.hostEncoded, name: FIXTURE.serviceEncoded, state: "running" },
    ],
  };

  return { config, overlay, snapshot };
}

/**
 * Build one complete, valid scale generation for the Chromium render gates.
 *
 * The E2E runtime's declared config is fixed by the API helper (7 hosts, 5
 * services); only the snapshot is mutable. This generation observes every
 * declared host/service by its exact identity plus enough invented
 * `fixture-scale-*` entities that the observed set — and therefore the
 * declared ∪ observed union the UI renders — is exactly 150 hosts and 300
 * services. Observing the declared identities keeps the union equal to the
 * observed cardinality, so the generated snapshot itself contains exactly 150
 * hosts and 300 services (REQ-PERF-01). Names stay under the `fixture-`
 * namespace and carry no estate facts.
 *
 * @param nowMs - Wall-clock epoch used for the fresh collection timestamps.
 */
export function buildScaleGeneration(nowMs: number): { snapshot: SnapshotDocument } {
  const collectedAt = new Date(nowMs).toISOString();
  const pad = (value: number): string => String(value).padStart(3, "0");
  const scaleHostName = (index: number): string => `fixture-scale-host-${pad(index)}`;

  /** The seven host identities the fixed E2E config declares. */
  const declaredHostNames = [
    FIXTURE.hostAlpha,
    FIXTURE.hostBravo,
    FIXTURE.hostCharlie,
    FIXTURE.hostDelta,
    FIXTURE.hostEcho,
    FIXTURE.hostFoxtrot,
    FIXTURE.hostEncoded,
  ];
  /** 7 declared + 143 invented observed hosts = 150 union rows. */
  const SCALE_HOSTS = 143;
  const hosts: ObservedHost[] = [
    ...declaredHostNames.map((name) => ({
      name,
      coverage: "collected" as const,
      collectedAt,
      reachable: true,
    })),
    ...Array.from({ length: SCALE_HOSTS }, (_unused, index) => ({
      name: scaleHostName(index),
      coverage: "collected" as const,
      collectedAt,
      reachable: true,
    })),
  ];

  /** The five `(host,name)` service identities the fixed E2E config declares. */
  const declaredServicePairs: ReadonlyArray<readonly [string, string]> = [
    [FIXTURE.hostAlpha, FIXTURE.serviceWeb],
    [FIXTURE.hostAlpha, FIXTURE.serviceDb],
    [FIXTURE.hostBravo, FIXTURE.serviceWeb],
    [FIXTURE.hostFoxtrot, FIXTURE.serviceCache],
    [FIXTURE.hostEncoded, FIXTURE.serviceEncoded],
  ];
  /** 5 declared + 295 invented observed services = 300 union rows. */
  const SCALE_SERVICES = 295;
  const services: ObservedService[] = [
    ...declaredServicePairs.map(([host, name]) => ({
      host,
      name,
      state: "running" as const,
    })),
    ...Array.from({ length: SCALE_SERVICES }, (_unused, index) => ({
      host: scaleHostName(index % SCALE_HOSTS),
      name: `fixture-scale-svc-${pad(index)}`,
      state: "running" as const,
    })),
  ];

  const snapshot: SnapshotDocument = {
    schemaVersion: 1,
    generatedAt: collectedAt,
    hosts,
    services,
  };

  // Assert the exact generated cardinalities rather than trusting the arithmetic.
  if (hosts.length !== 150 || services.length !== 300) {
    throw new Error(
      "Scale generation must contain exactly 150 hosts and 300 services.",
    );
  }
  return { snapshot };
}
