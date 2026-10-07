import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, expectTypeOf, it } from "vitest";

// The `../src/contract/index.js` barrel is the `@deck/server` public entry point
// (package.json `exports["."]`); importing it exercises the documented public
// surface. A package cannot self-resolve its own `exports` map inside its own
// tests, so the sibling drift suites import the barrel by this relative path.
import {
  buildEvidencePreview,
  compareCoverageRows,
  compareDriftFindings,
  COVERAGE_STATE_ORDER,
  deriveDriftProjection,
  driftServiceFacetKey,
  DRIFT_UI_DEFAULTS,
  DriftProjectionError,
  filterDriftProjection,
} from "../src/contract/index.js";
import type {
  CollectorFailureProjection,
  CoverageCounts,
  CoverageRow,
  DriftFilters,
  DriftFindingProjection,
  DriftProjection,
  DriftProjectionErrorCode,
  DriftServiceIdentity,
  DriftSeverity,
  DriftSeverityCounts,
  DriftSummary,
  EvidencePreview,
  EvidencePreviewLimits,
  EvidencePreviewReason,
  FilteredDriftCounts,
  FilteredDriftProjection,
  FindingHostGroup,
  FindingSubgroup,
  HostCollectionState,
  ProviderEnvelope,
  SnapshotProviderResult,
  WaiverState,
} from "../src/contract/index.js";
import type { JsonValue, Waiver } from "@deck/schema";

const NOW = new Date("2032-03-01T00:00:00.000Z");

/** Build a minimal invented available snapshot envelope for runtime assertions. */
function makeEnvelope(overrides: {
  drift?: unknown[];
  hosts?: unknown[];
  hostStates?: Record<string, unknown>;
}): ProviderEnvelope<SnapshotProviderResult> {
  return {
    id: "snapshot",
    kind: "snapshot",
    freshness: { state: "fresh", observedAt: "2032-03-01T00:00:00.000Z", ageMs: 0, ttlMs: 30_000 },
    data: {
      snapshot: {
        schemaVersion: 1,
        generatedAt: "2032-02-29T23:00:00.000Z",
        hosts: (overrides.hosts ?? []) as never,
        drift: (overrides.drift ?? []) as never,
      },
      findings: [] as never,
      hostStates: (overrides.hostStates ?? {}) as never,
      lastReadAt: "2032-02-29T23:30:00.000Z",
      readError: null as never,
    },
    error: null,
  } as ProviderEnvelope<SnapshotProviderResult>;
}

/** One invented drift finding with defaults overridable per test. */
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

// ---------------------------------------------------------------------------
// Public type contract: expectTypeOf + compile-time assignments
// ---------------------------------------------------------------------------

describe("public drift API type contract", () => {
  it("proves the exact public function signatures", () => {
    // Compile-time assignment: exact whole-signature proof (checked by `tsc --noEmit`).
    const derive: (
      envelope: Readonly<ProviderEnvelope<SnapshotProviderResult>>,
      now: Date,
    ) => DriftProjection = deriveDriftProjection;
    const filter: (
      projection: DriftProjection,
      filters: DriftFilters,
    ) => FilteredDriftProjection = filterDriftProjection;
    const evidence: (value: JsonValue, limits?: EvidencePreviewLimits) => EvidencePreview =
      buildEvidencePreview;
    const facetKey: (identity: DriftServiceIdentity) => string = driftServiceFacetKey;
    const compareFindings: (
      left: DriftFindingProjection,
      right: DriftFindingProjection,
    ) => -1 | 0 | 1 = compareDriftFindings;
    const compareCoverage: (left: CoverageRow, right: CoverageRow) => -1 | 0 | 1 =
      compareCoverageRows;

    for (const fn of [derive, filter, evidence, facetKey, compareFindings, compareCoverage]) {
      expect(typeof fn).toBe("function");
    }

    // Return-type proofs.
    expectTypeOf(deriveDriftProjection).returns.toEqualTypeOf<DriftProjection>();
    expectTypeOf(filterDriftProjection).returns.toEqualTypeOf<FilteredDriftProjection>();
    expectTypeOf(buildEvidencePreview).returns.toEqualTypeOf<EvidencePreview>();
    expectTypeOf(driftServiceFacetKey).returns.toEqualTypeOf<string>();
    expectTypeOf(compareDriftFindings).returns.toEqualTypeOf<-1 | 0 | 1>();
    expectTypeOf(compareCoverageRows).returns.toEqualTypeOf<-1 | 0 | 1>();

    // Representative parameter proofs.
    expectTypeOf(driftServiceFacetKey).parameter(0).toEqualTypeOf<DriftServiceIdentity>();
    expectTypeOf(buildEvidencePreview).parameter(1).toEqualTypeOf<EvidencePreviewLimits | undefined>();
    expectTypeOf(deriveDriftProjection).parameter(1).toEqualTypeOf<Date>();
    expectTypeOf(filterDriftProjection).parameter(1).toEqualTypeOf<DriftFilters>();
  });

  it("proves comparators/constants types", () => {
    expectTypeOf(COVERAGE_STATE_ORDER).toEqualTypeOf<readonly HostCollectionState[]>();
    expectTypeOf(DRIFT_UI_DEFAULTS.initialRowsPerGroup).toEqualTypeOf<25>();
    expectTypeOf(DRIFT_UI_DEFAULTS.additionalRowsPerStep).toEqualTypeOf<25>();
    expectTypeOf(DRIFT_UI_DEFAULTS.evidenceMaxDepth).toEqualTypeOf<4>();
    expectTypeOf(DRIFT_UI_DEFAULTS.evidenceMaxBytes).toEqualTypeOf<2_048>();
  });

  it("proves DriftSummary and projection member types", () => {
    expectTypeOf<DriftProjection["summary"]>().toEqualTypeOf<DriftSummary>();
    expectTypeOf<DriftSummary["activeSeverity"]>().toEqualTypeOf<DriftSeverityCounts>();
    expectTypeOf<DriftSummary["coverage"]>().toEqualTypeOf<CoverageCounts>();
    expectTypeOf<DriftSummary["totalFindings"]>().toEqualTypeOf<number>();
    expectTypeOf<DriftSummary["totalHosts"]>().toEqualTypeOf<number>();
    expectTypeOf<DriftProjection["findingGroups"]>().toEqualTypeOf<readonly FindingHostGroup[]>();
    expectTypeOf<DriftProjection["coverageRows"]>().toEqualTypeOf<readonly CoverageRow[]>();
    expectTypeOf<FindingHostGroup["subgroups"]>().toEqualTypeOf<readonly FindingSubgroup[]>();
    expectTypeOf<FindingSubgroup["findings"]>().toEqualTypeOf<readonly DriftFindingProjection[]>();
    expectTypeOf<CoverageRow["failedCollectors"]>().toEqualTypeOf<
      readonly CollectorFailureProjection[]
    >();
  });

  it("proves finding/filter/evidence member types", () => {
    expectTypeOf<DriftFindingProjection["severity"]>().toEqualTypeOf<DriftSeverity>();
    expectTypeOf<DriftFindingProjection["waiverState"]>().toEqualTypeOf<WaiverState>();
    // Optional evidence is `JsonValue | undefined`, preserving supplied-vs-absent meaning.
    expectTypeOf<DriftFindingProjection["expected"]>().toEqualTypeOf<JsonValue | undefined>();
    expectTypeOf<DriftFindingProjection["observed"]>().toEqualTypeOf<JsonValue | undefined>();
    expectTypeOf<DriftFindingProjection["service"]>().toEqualTypeOf<string | null>();
    expectTypeOf<DriftFindingProjection["waiver"]>().toEqualTypeOf<Readonly<Waiver> | null>();
    expectTypeOf<FilteredDriftProjection["source"]>().toEqualTypeOf<DriftProjection>();
    expectTypeOf<FilteredDriftProjection["total"]>().toEqualTypeOf<DriftSummary>();
    expectTypeOf<FilteredDriftProjection["filtered"]>().toEqualTypeOf<FilteredDriftCounts>();
    expectTypeOf<FilteredDriftProjection["hasActiveFilters"]>().toEqualTypeOf<boolean>();
    expectTypeOf<EvidencePreview["reasons"]>().toEqualTypeOf<readonly EvidencePreviewReason[]>();
    expectTypeOf<EvidencePreviewReason>().toEqualTypeOf<"depth" | "bytes">();
    expectTypeOf<DriftServiceIdentity>().toEqualTypeOf<{
      readonly host: string;
      readonly service: string;
    }>();
  });

  it("proves the DriftProjectionError constructor and code types", () => {
    const ctor: new (
      code: DriftProjectionErrorCode,
      message: string,
      options?: ErrorOptions,
    ) => DriftProjectionError = DriftProjectionError;
    expect(typeof ctor).toBe("function");
    expectTypeOf<DriftProjectionError["code"]>().toEqualTypeOf<DriftProjectionErrorCode>();
    expectTypeOf<DriftProjectionErrorCode>().toEqualTypeOf<
      "INVALID_CLOCK" | "INVALID_INPUT" | "DERIVATION_FAILED"
    >();
    expectTypeOf(new DriftProjectionError("INVALID_INPUT", "x")).toMatchTypeOf<Error>();
  });
});

// ---------------------------------------------------------------------------
// Runtime: error export identity and fixed codes/messages
// ---------------------------------------------------------------------------

describe("DriftProjectionError export identity and fixed errors", () => {
  it("is the same runtime class thrown by the projection functions", () => {
    let thrown: unknown;
    try {
      deriveDriftProjection(makeEnvelope({}), new Date(Number.NaN));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DriftProjectionError);
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as DriftProjectionError).name).toBe("DriftProjectionError");
    expect((thrown as DriftProjectionError).constructor).toBe(DriftProjectionError);
  });

  it("throws INVALID_CLOCK with the fixed message for a non-finite Date", () => {
    const error = captureError(() => deriveDriftProjection(makeEnvelope({}), new Date(Number.NaN)));
    expect(error.code).toBe("INVALID_CLOCK");
    expect(error.message).toBe("Projection clock must be a valid Date.");
  });

  it("throws INVALID_INPUT with the fixed message for an unavailable generation", () => {
    const unavailable = { ...makeEnvelope({}), data: null };
    const error = captureError(() => deriveDriftProjection(unavailable, NOW));
    expect(error.code).toBe("INVALID_INPUT");
    expect(error.message).toBe("Projection input is not an available snapshot generation.");
  });

  it("throws INVALID_INPUT with fixed messages for non-JSON evidence", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const previewError = captureError(() => buildEvidencePreview(cyclic as JsonValue));
    expect(previewError.code).toBe("INVALID_INPUT");
    expect(previewError.message).toBe("Evidence value must be valid JSON data.");

    const limitError = captureError(() => buildEvidencePreview(1 as JsonValue, { maxBytes: -1 }));
    expect(limitError.code).toBe("INVALID_INPUT");
    expect(limitError.message).toBe(
      "Evidence preview limits must be non-negative safe integers.",
    );
  });

  it("normalizes an unexpected internal failure to DERIVATION_FAILED without leaking cause text", () => {
    const SECRET = "internal-boom-sentinel";
    const hostStates: Record<string, unknown> = {};
    // A throwing enumerable getter passes the plain-object guard but explodes when
    // the derivation reads host-state entries, exercising the DERIVATION_FAILED path.
    Object.defineProperty(hostStates, "poison.invalid", {
      enumerable: true,
      get() {
        throw new Error(SECRET);
      },
    });
    const error = captureError(() => deriveDriftProjection(makeEnvelope({ hostStates }), NOW));
    expect(error.code).toBe("DERIVATION_FAILED");
    expect(error.message).toBe("Drift projection could not be derived.");
    expect(error.message).not.toContain(SECRET);
  });

  it("constructs each fixed error code with a stable shape", () => {
    for (const code of ["INVALID_CLOCK", "INVALID_INPUT", "DERIVATION_FAILED"] as const) {
      const error = new DriftProjectionError(code, "fixed message");
      expect(error.code).toBe(code);
      expect(error.name).toBe("DriftProjectionError");
      expect(error).toBeInstanceOf(DriftProjectionError);
    }
  });
});

// ---------------------------------------------------------------------------
// Runtime: recursive freezing and source isolation
// ---------------------------------------------------------------------------

describe("recursive freezing and source isolation", () => {
  it("recursively freezes every owned projection object", () => {
    const projection = deriveDriftProjection(
      makeEnvelope({
        drift: [drift({ expected: { nested: [1, 2] }, waiver: { reason: "r", who: "w" } })],
        hostStates: {
          "alpha.invalid": {
            state: "partial",
            collectedAt: null,
            ageMs: null,
            pastStaleThreshold: false,
          },
        },
        hosts: [
          {
            name: "alpha.invalid",
            coverage: "partial",
            collectors: { succeeded: [], failed: [{ name: "c", reason: "why" }] },
          },
        ],
      }),
      NOW,
    );
    expect(Object.isFrozen(projection)).toBe(true);
    expect(Object.isFrozen(projection.summary)).toBe(true);
    expect(Object.isFrozen(projection.summary.activeSeverity)).toBe(true);
    expect(Object.isFrozen(projection.summary.coverage)).toBe(true);
    expect(Object.isFrozen(projection.findingGroups)).toBe(true);
    const finding = firstFinding(projection);
    expect(Object.isFrozen(finding)).toBe(true);
    expect(Object.isFrozen(finding.expected)).toBe(true);
    expect(Object.isFrozen(finding.waiver)).toBe(true);
    expect(Object.isFrozen(projection.coverageRows[0])).toBe(true);
    expect(Object.isFrozen(projection.coverageRows[0]!.failedCollectors)).toBe(true);
    expect(Object.isFrozen(projection.providerFreshness)).toBe(true);
  });

  it("freezes filtered and evidence results", () => {
    const projection = deriveDriftProjection(makeEnvelope({ drift: [drift()] }), NOW);
    const filtered = filterDriftProjection(projection, emptyFilters());
    expect(Object.isFrozen(filtered)).toBe(true);
    expect(Object.isFrozen(filtered.findingGroups)).toBe(true);
    expect(Object.isFrozen(filtered.filtered)).toBe(true);

    const preview = buildEvidencePreview({ a: [1, 2, 3] });
    expect(Object.isFrozen(preview)).toBe(true);
    expect(Object.isFrozen(preview.reasons)).toBe(true);
  });

  it("does not mutate or freeze inputs to derive/filter", () => {
    const envelope = makeEnvelope({
      drift: [drift({ expected: { a: 1 } })],
      hostStates: {
        "alpha.invalid": {
          state: "fresh",
          collectedAt: "2032-02-29T23:00:00.000Z",
          ageMs: 1,
          pastStaleThreshold: false,
        },
      },
    });
    const projection = deriveDriftProjection(envelope, NOW);
    expect(Object.isFrozen(envelope)).toBe(false);
    expect(Object.isFrozen(envelope.data)).toBe(false);
    expect(Object.isFrozen(envelope.data!.snapshot.drift)).toBe(false);

    // Filtering must not mutate the source projection or the supplied filter sets.
    const severities = new Set<DriftSeverity>(["error"]);
    const filters: DriftFilters = { ...emptyFilters(), severities };
    const beforeGroups = projection.findingGroups;
    filterDriftProjection(projection, filters);
    expect(projection.findingGroups).toBe(beforeGroups);
    expect([...severities]).toEqual(["error"]);
  });
});

// ---------------------------------------------------------------------------
// Runtime: omission-versus-presence semantics
// ---------------------------------------------------------------------------

describe("omission versus presence semantics", () => {
  it("distinguishes absent evidence (undefined) from a supplied null", () => {
    const absent = firstFinding(deriveDriftProjection(makeEnvelope({ drift: [drift()] }), NOW));
    expect(absent.expected).toBeUndefined();
    expect(absent.observed).toBeUndefined();

    const suppliedNull = firstFinding(
      deriveDriftProjection(
        makeEnvelope({ drift: [drift({ expected: null, observed: null })] }),
        NOW,
      ),
    );
    expect(suppliedNull.expected).toBeNull();
    expect(suppliedNull.observed).toBeNull();
  });

  it("preserves supplied falsy evidence values exactly", () => {
    for (const value of [false, 0, "", [], {}] as const) {
      const finding = firstFinding(
        deriveDriftProjection(makeEnvelope({ drift: [drift({ expected: value })] }), NOW),
      );
      expect(finding.expected).toEqual(value);
      expect("expected" in finding).toBe(true);
    }
  });

  it("preserves absent optional waiver as null, not a fabricated object", () => {
    const finding = firstFinding(deriveDriftProjection(makeEnvelope({ drift: [drift()] }), NOW));
    expect(finding.waiver).toBeNull();
    expect(finding.waiverState).toBe("unwaived");
  });

  it("preserves supplied falsy evidence through the evidence preview", () => {
    for (const value of [false, 0, "", null] as JsonValue[]) {
      const preview = buildEvidencePreview(value);
      expect(preview.fullValue).toEqual(value);
      expect(preview.truncated).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Browser-safety guard: the public drift graph loads no server-only runtime/global
// ---------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url));
const DRIFT_DIR = resolve(HERE, "../src/drift");
const DRIFT_ENTRY = resolve(DRIFT_DIR, "index.ts");

/**
 * Documented server-only import specifiers a browser bundle of the drift graph
 * must never load: Bun, Node built-ins, Hono, Pino, filesystem, and networking.
 */
const FORBIDDEN_MODULE = /^(?:node:|bun(?::|$)|hono(?:\/|$)|pino(?:\/|$)|(?:fs|path|os|crypto|http|https|http2|net|dns|tls|url|stream|zlib|events|child_process|worker_threads|process|module|vm|readline|dgram|cluster|inspector)$)/;

/**
 * Documented server-only globals / DOM handles the drift source must not touch.
 * Each needle is applied as a word-boundary or call/property pattern so ordinary
 * prose (for example, "require a complete projection") cannot trip the guard.
 */
const FORBIDDEN_GLOBAL: readonly (readonly [string, RegExp])[] = [
  ["Bun", /\bBun\b/],
  ["process", /\bprocess\b/],
  ["require()", /\brequire\s*\(/],
  ["__dirname", /\b__dirname\b/],
  ["__filename", /\b__filename\b/],
  ["document", /\bdocument\b/],
  ["window", /\bwindow\b/],
  ["localStorage", /\blocalStorage\b/],
  ["sessionStorage", /\bsessionStorage\b/],
  ["dangerouslySetInnerHTML", /\bdangerouslySetInnerHTML\b/],
  ["innerHTML", /\binnerHTML\b/],
  ["node: specifier", /["']node:/],
];

/**
 * Return the value (non-type-only) import/export specifiers in `source`. A
 * browser bundler erases `import type` / `export type` statements and named
 * clauses whose every binding is inline `type`, so those are excluded here; the
 * remaining specifiers are the modules actually loaded at runtime.
 */
function valueModuleSpecifiers(source: string): string[] {
  const specs: string[] = [];
  const fromStatement = /^[ \t]*(?:import|export)\b([\s\S]*?)\bfrom[ \t]*["']([^"']+)["']/gm;
  for (let match = fromStatement.exec(source); match; match = fromStatement.exec(source)) {
    const clause = match[1]!;
    if (/^\s*type\b/.test(clause)) continue; // `import type …` / `export type …`
    const braced = /\{([\s\S]*)\}/.exec(clause);
    if (braced) {
      const names = braced[1]!.split(",").map((name) => name.trim()).filter(Boolean);
      if (names.length > 0 && names.every((name) => /^type\s/.test(name))) continue;
    }
    specs.push(match[2]!);
  }
  const sideEffect = /^[ \t]*import[ \t]*["']([^"']+)["'][ \t]*;?[ \t]*$/gm;
  for (let match = sideEffect.exec(source); match; match = sideEffect.exec(source)) {
    specs.push(match[1]!);
  }
  return specs;
}

/** Resolve a relative `.js` specifier to its authored `.ts` module path. */
function resolveRelative(fromFile: string, specifier: string): string {
  const base = resolve(dirname(fromFile), specifier);
  return base.endsWith(".js") ? `${base.slice(0, -3)}.ts` : `${base}.ts`;
}

describe("public drift export graph is browser-safe", () => {
  it("loads only drift-local modules and no server-only runtime, then scans for globals", () => {
    const visited = new Set<string>();
    const bareSpecifiers = new Set<string>();
    const queue = [DRIFT_ENTRY];

    while (queue.length > 0) {
      const file = queue.pop()!;
      if (visited.has(file)) continue;
      visited.add(file);

      // Every runtime-loaded module must stay inside the drift feature directory.
      expect(file.startsWith(DRIFT_DIR)).toBe(true);

      const source = readFileSync(file, "utf8");
      for (const specifier of valueModuleSpecifiers(source)) {
        if (specifier.startsWith(".")) {
          queue.push(resolveRelative(file, specifier));
        } else {
          bareSpecifiers.add(specifier);
        }
      }
    }

    // Universe guard: an empty or truncated walk must not silently pass.
    expect(visited.size).toBeGreaterThanOrEqual(6);
    for (const name of ["index", "types", "ordering", "derive", "filter", "evidence"]) {
      expect(visited.has(resolve(DRIFT_DIR, `${name}.ts`))).toBe(true);
    }

    // The runtime value graph pulls in zero bare (non-relative) modules — so no
    // Bun, Node built-in, Hono, Pino, @deck/schema value, or provider/boot module.
    expect([...bareSpecifiers]).toEqual([]);
    for (const specifier of bareSpecifiers) {
      expect(specifier).not.toMatch(FORBIDDEN_MODULE);
    }

    // Lexical global/specifier scan across the same graph files.
    for (const file of visited) {
      const source = readFileSync(file, "utf8");
      for (const [label, pattern] of FORBIDDEN_GLOBAL) {
        expect(
          pattern.test(source),
          `${file} must not reference ${label}`,
        ).toBe(false);
      }
    }
  });
});

/** Empty (all-permissive) filter criteria. */
function emptyFilters(): DriftFilters {
  return {
    text: "",
    severities: new Set<DriftSeverity>(),
    hosts: new Set<string>(),
    services: new Set<string>(),
    categories: new Set<string>(),
    waiverStates: new Set<WaiverState>(),
    coverageHosts: new Set<string>(),
    coverageStates: new Set<HostCollectionState>(),
  };
}

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
