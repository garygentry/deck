import { describe, expect, it } from "vitest";

// The `../src/contract/index.js` barrel is the `@deck/server` public entry point
// (package.json `exports["."]`); importing it exercises the documented public surface.
import {
  COVERAGE_STATE_ORDER,
  DRIFT_UI_DEFAULTS,
  compareCoverageRows,
  compareDriftFindings,
  deriveDriftProjection,
  DriftProjectionError,
} from "../src/contract/index.js";
import type {
  CoverageRow,
  DriftFindingProjection,
  DriftProjection,
  ProviderEnvelope,
  SnapshotProviderResult,
} from "../src/contract/index.js";

const NOW = new Date("2030-06-01T00:00:00.000Z");

/** Build a minimal invented available envelope, overriding snapshot/hostStates parts. */
function makeEnvelope(overrides: {
  drift?: unknown[];
  hosts?: unknown[];
  hostStates?: Record<string, unknown>;
  findings?: unknown[];
  readError?: unknown;
}): ProviderEnvelope<SnapshotProviderResult> {
  return {
    id: "snapshot",
    kind: "snapshot",
    freshness: {
      state: "fresh",
      observedAt: "2030-06-01T00:00:00.000Z",
      ageMs: 0,
      ttlMs: 30_000,
    },
    data: {
      snapshot: {
        schemaVersion: 1,
        generatedAt: "2030-05-31T23:00:00.000Z",
        hosts: (overrides.hosts ?? []) as never,
        drift: (overrides.drift ?? []) as never,
      },
      findings: (overrides.findings ?? []) as never,
      hostStates: (overrides.hostStates ?? {}) as never,
      lastReadAt: "2030-05-31T23:30:00.000Z",
      readError: (overrides.readError ?? null) as never,
    },
    error: null,
  } as ProviderEnvelope<SnapshotProviderResult>;
}

/** A single drift finding fixture with defaults overridable per test. */
function drift(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "d-1",
    severity: "error",
    location: { host: "alpha.invalid" },
    category: "cat.a",
    message: "Invented mismatch",
    ...overrides,
  };
}

function firstFinding(projection: DriftProjection): DriftFindingProjection {
  const finding = projection.findingGroups[0]?.subgroups[0]?.findings[0];
  if (!finding) throw new Error("expected at least one finding");
  return finding;
}

describe("public runtime exports", () => {
  it("exposes the documented functions, constants, comparators, and error", () => {
    expect(typeof deriveDriftProjection).toBe("function");
    expect(typeof compareDriftFindings).toBe("function");
    expect(typeof compareCoverageRows).toBe("function");
    expect(typeof DriftProjectionError).toBe("function");
    expect(COVERAGE_STATE_ORDER).toEqual([
      "unreachable",
      "never-collected",
      "partial",
      "stale",
      "fresh",
    ]);
    expect(DRIFT_UI_DEFAULTS).toMatchObject({
      initialRowsPerGroup: 25,
      additionalRowsPerStep: 25,
      evidenceMaxDepth: 4,
      evidenceMaxBytes: 2_048,
    });
    expect(Object.isFrozen(COVERAGE_STATE_ORDER)).toBe(true);
    expect(Object.isFrozen(DRIFT_UI_DEFAULTS)).toBe(true);
  });

  it("DriftProjectionError carries the stable name and code", () => {
    const error = new DriftProjectionError("INVALID_INPUT", "boom");
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("DriftProjectionError");
    expect(error.code).toBe("INVALID_INPUT");
  });
});

describe("fixed projection errors", () => {
  it("throws INVALID_CLOCK for a non-finite Date", () => {
    try {
      deriveDriftProjection(makeEnvelope({}), new Date(NaN));
      throw new Error("expected throw");
    } catch (error) {
      expect(error).toBeInstanceOf(DriftProjectionError);
      expect((error as DriftProjectionError).code).toBe("INVALID_CLOCK");
      expect((error as DriftProjectionError).message).toBe("Projection clock must be a valid Date.");
    }
  });

  it("throws INVALID_CLOCK for a non-Date clock", () => {
    // @ts-expect-error deliberate misuse of the clock argument
    const error = captureError(() => deriveDriftProjection(makeEnvelope({}), 0));
    expect(error.code).toBe("INVALID_CLOCK");
  });

  it("throws INVALID_INPUT for an unavailable generation", () => {
    const unavailable = { ...makeEnvelope({}), data: null };
    const error = captureError(() => deriveDriftProjection(unavailable, NOW));
    expect(error.code).toBe("INVALID_INPUT");
    expect(error.message).toBe("Projection input is not an available snapshot generation.");
  });

  it("throws INVALID_INPUT for a structurally impossible consumed value", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const error = captureError(() =>
      deriveDriftProjection(makeEnvelope({ drift: [drift({ expected: cyclic })] }), NOW),
    );
    expect(error.code).toBe("INVALID_INPUT");
  });

  it("clock validation precedes input validation", () => {
    const unavailable = { ...makeEnvelope({}), data: null };
    const error = captureError(() => deriveDriftProjection(unavailable, new Date(NaN)));
    expect(error.code).toBe("INVALID_CLOCK");
  });
});

describe("source isolation and immutability", () => {
  it("recursively freezes the returned projection", () => {
    const projection = deriveDriftProjection(
      makeEnvelope({
        drift: [drift({ expected: { nested: [1, 2] }, waiver: { reason: "r", who: "w" } })],
        hosts: [{ name: "alpha.invalid", coverage: "partial", collectors: { succeeded: [], failed: [{ name: "c", reason: "why" }] } }],
        hostStates: { "alpha.invalid": { state: "partial", collectedAt: null, ageMs: null, pastStaleThreshold: false } },
      }),
      NOW,
    );
    expect(Object.isFrozen(projection)).toBe(true);
    expect(Object.isFrozen(projection.summary)).toBe(true);
    expect(Object.isFrozen(projection.summary.activeSeverity)).toBe(true);
    expect(Object.isFrozen(projection.findingGroups)).toBe(true);
    const finding = firstFinding(projection);
    expect(Object.isFrozen(finding)).toBe(true);
    expect(Object.isFrozen(finding.expected)).toBe(true);
    expect(Object.isFrozen(finding.waiver)).toBe(true);
    expect(Object.isFrozen(projection.coverageRows[0])).toBe(true);
    expect(Object.isFrozen(projection.coverageRows[0]!.failedCollectors)).toBe(true);
    expect(Object.isFrozen(projection.providerFreshness)).toBe(true);
  });

  it("does not mutate or freeze the input envelope", () => {
    const envelope = makeEnvelope({
      drift: [drift({ expected: { a: 1 } })],
      hostStates: { "alpha.invalid": { state: "fresh", collectedAt: "2030-05-31T23:00:00.000Z", ageMs: 1, pastStaleThreshold: false } },
    });
    deriveDriftProjection(envelope, NOW);
    expect(Object.isFrozen(envelope)).toBe(false);
    expect(Object.isFrozen(envelope.data)).toBe(false);
    expect(Object.isFrozen(envelope.data!.snapshot.drift)).toBe(false);
    expect((envelope.data!.snapshot.drift as unknown[]).length).toBe(1);
  });

  it("copies evidence into an independently owned tree", () => {
    const evidence = { arr: [{ k: "v" }] };
    const envelope = makeEnvelope({ drift: [drift({ observed: evidence })] });
    const projection = deriveDriftProjection(envelope, NOW);
    const finding = firstFinding(projection);
    expect(finding.observed).toEqual(evidence);
    expect(finding.observed).not.toBe(evidence);
  });
});

describe("waiver boundaries", () => {
  function classify(waiver: Record<string, unknown> | undefined): DriftFindingProjection {
    const envelope = makeEnvelope({ drift: [drift(waiver ? { waiver } : {})] });
    return firstFinding(deriveDriftProjection(envelope, NOW));
  }

  it("classifies an absent waiver as unwaived", () => {
    const finding = classify(undefined);
    expect(finding.waiverState).toBe("unwaived");
    expect(finding.waiver).toBeNull();
    expect(finding.waiverWarning).toBeNull();
  });

  it("classifies an omitted until as active and omits it in the copy", () => {
    const finding = classify({ reason: "r", who: "w" });
    expect(finding.waiverState).toBe("active");
    expect(finding.waiver && "until" in finding.waiver).toBe(false);
  });

  it("classifies a future until as active", () => {
    const finding = classify({ reason: "r", who: "w", until: "2030-06-01T00:00:00.001Z" });
    expect(finding.waiverState).toBe("active");
  });

  it("classifies until equal to now as expired", () => {
    const finding = classify({ reason: "r", who: "w", until: "2030-06-01T00:00:00.000Z" });
    expect(finding.waiverState).toBe("expired");
    expect(finding.waiverWarning).toBeNull();
  });

  it("classifies a past until as expired", () => {
    const finding = classify({ reason: "r", who: "w", until: "2029-01-01T00:00:00.000Z" });
    expect(finding.waiverState).toBe("expired");
  });

  it("classifies a malformed until as expired with the fixed warning", () => {
    const finding = classify({ reason: "r", who: "w", until: "not-a-date" });
    expect(finding.waiverState).toBe("expired");
    expect(finding.waiverWarning).toBe("Waiver expiry is malformed; treated as expired.");
  });

  it("rejects an implementation-dependent date string as malformed", () => {
    // Date.parse accepts this, but strict RFC 3339 does not.
    const finding = classify({ reason: "r", who: "w", until: "June 1, 2031" });
    expect(finding.waiverState).toBe("expired");
    expect(finding.waiverWarning).toBe("Waiver expiry is malformed; treated as expired.");
  });
});

describe("estate drift source isolation", () => {
  it("reads snapshot.drift and never the validation findings member", () => {
    const envelope = makeEnvelope({
      drift: [drift({ id: "real" })],
      findings: [{ id: "validation", severity: "error", message: "should be ignored", code: "X" }],
    });
    const projection = deriveDriftProjection(envelope, NOW);
    expect(projection.summary.totalFindings).toBe(1);
    expect(firstFinding(projection).id).toBe("real");
  });

  it("treats an absent drift array as zero findings", () => {
    const envelope = makeEnvelope({ findings: [{ id: "x" }] });
    delete (envelope.data!.snapshot as unknown as Record<string, unknown>).drift;
    const projection = deriveDriftProjection(envelope, NOW);
    expect(projection.summary.totalFindings).toBe(0);
    expect(projection.findingGroups).toEqual([]);
  });
});

describe("deterministic grouping and ordering", () => {
  it("orders host groups and service subgroups by exact code units, host-level first", () => {
    const envelope = makeEnvelope({
      drift: [
        drift({ id: "b-svc", location: { host: "beta.invalid", service: "svc-b" } }),
        drift({ id: "b-hostlevel", location: { host: "beta.invalid" } }),
        drift({ id: "b-svc-a", location: { host: "beta.invalid", service: "svc-a" } }),
        drift({ id: "a-only", location: { host: "alpha.invalid" } }),
      ],
    });
    const projection = deriveDriftProjection(envelope, NOW);
    expect(projection.findingGroups.map((g) => g.host)).toEqual(["alpha.invalid", "beta.invalid"]);
    const beta = projection.findingGroups[1]!;
    expect(beta.subgroups.map((s) => s.service)).toEqual([null, "svc-a", "svc-b"]);
    expect(beta.findingCount).toBe(3);
  });

  it("orders findings by severity, then active risk, then category, then id", () => {
    const envelope = makeEnvelope({
      drift: [
        drift({ id: "info-1", severity: "info", category: "c" }),
        drift({ id: "warn-1", severity: "warning", category: "c" }),
        drift({ id: "err-b", severity: "error", category: "b" }),
        drift({ id: "err-a2", severity: "error", category: "a" }),
        drift({ id: "err-a1", severity: "error", category: "a" }),
        drift({ id: "err-waived", severity: "error", category: "a", waiver: { reason: "r", who: "w", until: "2099-01-01T00:00:00.000Z" } }),
      ],
    });
    const projection = deriveDriftProjection(envelope, NOW);
    const ids = projection.findingGroups[0]!.subgroups[0]!.findings.map((f) => f.id);
    // Within severity, active-risk (unwaived/expired) precedes an active waiver,
    // so err-waived sorts after all active-risk errors regardless of category.
    expect(ids).toEqual(["err-a1", "err-a2", "err-b", "err-waived", "warn-1", "info-1"]);
  });

  it("comparators never use locale collation and return -1|0|1", () => {
    const left = { severity: "error", waiverState: "unwaived", category: "a", id: "1" } as DriftFindingProjection;
    const right = { severity: "warning", waiverState: "unwaived", category: "a", id: "1" } as DriftFindingProjection;
    expect(compareDriftFindings(left, right)).toBe(-1);
    expect(compareDriftFindings(left, left)).toBe(0);
    const cov = (host: string, state: CoverageRow["state"]): CoverageRow =>
      ({ host, state } as CoverageRow);
    expect(compareCoverageRows(cov("a", "unreachable"), cov("b", "fresh"))).toBe(-1);
  });
});

describe("coverage projection", () => {
  it("projects every hostStates key once with the attention-first order", () => {
    const envelope = makeEnvelope({
      hostStates: {
        "z-fresh.invalid": { state: "fresh", collectedAt: null, ageMs: null, pastStaleThreshold: false },
        "a-unreachable.invalid": { state: "unreachable", collectedAt: null, ageMs: null, pastStaleThreshold: false },
        "m-partial.invalid": { state: "partial", collectedAt: null, ageMs: null, pastStaleThreshold: false },
      },
    });
    const projection = deriveDriftProjection(envelope, NOW);
    expect(projection.coverageRows.map((r) => r.host)).toEqual([
      "a-unreachable.invalid",
      "m-partial.invalid",
      "z-fresh.invalid",
    ]);
    expect(projection.summary.totalHosts).toBe(3);
  });

  it("preserves null timestamps, clamps future ages to zero, and ages past collections", () => {
    const envelope = makeEnvelope({
      hostStates: {
        "none.invalid": { state: "never-collected", collectedAt: null, ageMs: null, pastStaleThreshold: false },
        "future.invalid": { state: "fresh", collectedAt: "2030-06-02T00:00:00.000Z", ageMs: 0, pastStaleThreshold: false },
        "past.invalid": { state: "stale", collectedAt: "2030-05-31T00:00:00.000Z", ageMs: 0, pastStaleThreshold: true },
      },
    });
    const projection = deriveDriftProjection(envelope, NOW);
    const byHost = new Map(projection.coverageRows.map((r) => [r.host, r]));
    expect(byHost.get("none.invalid")).toMatchObject({ collectedAt: null, ageMs: null });
    expect(byHost.get("future.invalid")!.ageMs).toBe(0);
    expect(byHost.get("past.invalid")!.ageMs).toBe(24 * 60 * 60 * 1000);
    expect(byHost.get("past.invalid")!.pastStaleThreshold).toBe(true);
  });

  it("copies and sorts failed collectors only for partial hosts", () => {
    const envelope = makeEnvelope({
      hosts: [
        {
          name: "partial.invalid",
          coverage: "partial",
          collectors: {
            succeeded: ["ok"],
            failed: [
              { name: "Beta", reason: "z" },
              { name: "alpha", reason: "y" },
              { name: "Beta", reason: "a" },
            ],
          },
        },
        {
          name: "fresh.invalid",
          coverage: "collected",
          collectors: { succeeded: ["ok"], failed: [{ name: "ignored", reason: "n/a" }] },
        },
      ],
      hostStates: {
        "partial.invalid": { state: "partial", collectedAt: null, ageMs: null, pastStaleThreshold: false },
        "fresh.invalid": { state: "fresh", collectedAt: null, ageMs: null, pastStaleThreshold: false },
      },
    });
    const projection = deriveDriftProjection(envelope, NOW);
    const byHost = new Map(projection.coverageRows.map((r) => [r.host, r]));
    expect(byHost.get("partial.invalid")!.failedCollectors).toEqual([
      { name: "alpha", reason: "y" },
      { name: "Beta", reason: "a" },
      { name: "Beta", reason: "z" },
    ]);
    // Successful collectors are never exposed and non-partial rows carry none.
    expect(byHost.get("fresh.invalid")!.failedCollectors).toEqual([]);
  });

  it("keeps a partial row visible with no collectors when observed data is missing", () => {
    const envelope = makeEnvelope({
      hostStates: { "partial.invalid": { state: "partial", collectedAt: null, ageMs: null, pastStaleThreshold: false } },
    });
    const projection = deriveDriftProjection(envelope, NOW);
    expect(projection.coverageRows[0]).toMatchObject({ state: "partial", failedCollectors: [] });
  });

  it("throws INVALID_INPUT for a malformed collectedAt timestamp", () => {
    const envelope = makeEnvelope({
      hostStates: { "bad.invalid": { state: "fresh", collectedAt: "nope", ageMs: null, pastStaleThreshold: false } },
    });
    const error = captureError(() => deriveDriftProjection(envelope, NOW));
    expect(error.code).toBe("INVALID_INPUT");
  });
});

describe("summary totals", () => {
  it("computes complete active/waiver/coverage totals with the documented invariants", () => {
    const envelope = makeEnvelope({
      drift: [
        drift({ id: "e", severity: "error" }),
        drift({ id: "w", severity: "warning" }),
        drift({ id: "i", severity: "info" }),
        drift({ id: "active", severity: "error", waiver: { reason: "r", who: "w", until: "2099-01-01T00:00:00.000Z" } }),
        drift({ id: "expired", severity: "warning", waiver: { reason: "r", who: "w", until: "2000-01-01T00:00:00.000Z" } }),
        drift({ id: "malformed", severity: "info", waiver: { reason: "r", who: "w", until: "xxx" } }),
      ],
      hostStates: {
        "h1.invalid": { state: "fresh", collectedAt: null, ageMs: null, pastStaleThreshold: false },
        "h2.invalid": { state: "stale", collectedAt: null, ageMs: null, pastStaleThreshold: true },
        "h3.invalid": { state: "unreachable", collectedAt: null, ageMs: null, pastStaleThreshold: false },
      },
    });
    const { summary } = deriveDriftProjection(envelope, NOW);

    expect(summary.totalFindings).toBe(6);
    expect(summary.activeWaivers).toBe(1);
    expect(summary.expiredWaivers).toBe(2); // expired + malformed
    // active severity includes unwaived + expired (incl. malformed), excludes active waiver.
    expect(summary.activeSeverity).toEqual({ error: 1, warning: 2, info: 2 });
    expect(summary.coverage).toEqual({ fresh: 1, stale: 1, partial: 0, unreachable: 1, "never-collected": 0 });
    expect(summary.totalHosts).toBe(3);

    expect(summary.totalFindings).toBe(
      summary.activeSeverity.error + summary.activeSeverity.warning + summary.activeSeverity.info + summary.activeWaivers,
    );
    expect(summary.totalHosts).toBe(
      summary.coverage.fresh +
        summary.coverage.stale +
        summary.coverage.partial +
        summary.coverage.unreachable +
        summary.coverage["never-collected"],
    );
  });
});

describe("provider metadata", () => {
  it("copies provider metadata and derives the display clock", () => {
    const envelope = makeEnvelope({
      readError: { code: "HTTP_STATUS", message: "safe remediation text", httpStatus: 503 },
    });
    const projection = deriveDriftProjection(envelope, NOW);
    expect(projection.snapshotGeneratedAt).toBe("2030-05-31T23:00:00.000Z");
    expect(projection.providerObservedAt).toBe("2030-06-01T00:00:00.000Z");
    expect(projection.lastSuccessfulReadAt).toBe("2030-05-31T23:30:00.000Z");
    expect(projection.derivedAt).toBe(NOW.toISOString());
    expect(projection.providerFreshness).toEqual({ state: "fresh", observedAt: "2030-06-01T00:00:00.000Z", ageMs: 0, ttlMs: 30_000 });
    expect(projection.providerFreshness).not.toBe(envelope.freshness);
    expect(projection.readError).toEqual({ code: "HTTP_STATUS", message: "safe remediation text", httpStatus: 503 });
  });
});

/** Assert a call throws a DriftProjectionError and return it. */
function captureError(run: () => unknown): DriftProjectionError {
  try {
    run();
  } catch (error) {
    if (error instanceof DriftProjectionError) return error;
    throw error;
  }
  throw new Error("expected DriftProjectionError to be thrown");
}
