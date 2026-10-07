import { describe, expect, it } from "vitest";

// `../src/index.js` is the `@deck/drift` public entry point (package.json `exports["."]`).
import {
  deriveDriftProjection,
  driftServiceFacetKey,
  DriftProjectionError,
  filterDriftProjection,
} from "../src/index.js";
import type {
  DriftFilters,
  DriftProjection,
  FilteredDriftProjection,
} from "../src/index.js";
import type {
  ProviderEnvelope,
  SnapshotProviderResult,
} from "@deck/contract";

const NOW = new Date("2030-06-01T00:00:00.000Z");

/** Build a minimal available envelope over invented drift/hostStates fixtures. */
function makeEnvelope(drift: unknown[], hostStates: Record<string, unknown>): ProviderEnvelope<SnapshotProviderResult> {
  return {
    id: "snapshot",
    kind: "snapshot",
    freshness: { state: "fresh", observedAt: "2030-06-01T00:00:00.000Z", ageMs: 0, ttlMs: 30_000 },
    data: {
      snapshot: { schemaVersion: 1, generatedAt: "2030-05-31T23:00:00.000Z", hosts: [], drift: drift as never },
      findings: [],
      hostStates: hostStates as never,
      lastReadAt: "2030-05-31T23:30:00.000Z",
      readError: null,
    },
    error: null,
  } as ProviderEnvelope<SnapshotProviderResult>;
}

/** Invented, field-isolatable finding fixtures grouped host-a then host-b. */
const DRIFT: readonly Record<string, unknown>[] = [
  {
    id: "find-uno",
    severity: "error",
    category: "cat-alpha",
    message: "msg one",
    location: { host: "host-a.invalid", path: "/path/one" },
  },
  {
    id: "find-dos",
    severity: "warning",
    category: "cat-beta",
    message: "msg two",
    location: { host: "host-a.invalid", service: "svc-red" },
  },
  {
    id: "find-tres",
    severity: "info",
    category: "cat-alpha",
    message: "msg three",
    location: { host: "host-b.invalid" },
  },
  {
    id: "find-cuatro",
    severity: "error",
    category: "cat-gamma",
    message: "msg four",
    location: { host: "host-b.invalid", service: "svc-blue", path: "/path/four" },
    waiver: { reason: "r", who: "w", until: "2099-01-01T00:00:00.000Z" },
  },
];

const HOST_STATES: Record<string, unknown> = {
  "host-a.invalid": { state: "partial", collectedAt: null, ageMs: null, pastStaleThreshold: false },
  "host-b.invalid": { state: "fresh", collectedAt: null, ageMs: null, pastStaleThreshold: false },
  "host-c.invalid": { state: "unreachable", collectedAt: null, ageMs: null, pastStaleThreshold: false },
};

function projection(): DriftProjection {
  return deriveDriftProjection(makeEnvelope([...DRIFT], HOST_STATES), NOW);
}

/** A frozen-union `ReadonlySet` from string values; typed via the target field. */
function set<T>(values: readonly string[]): ReadonlySet<T> {
  return new Set(values) as unknown as ReadonlySet<T>;
}

/** Build filter criteria from string arrays, defaulting each unset facet to empty. */
function filters(overrides: {
  text?: string;
  severities?: string[];
  hosts?: string[];
  services?: string[];
  categories?: string[];
  waiverStates?: string[];
  coverageHosts?: string[];
  coverageStates?: string[];
} = {}): DriftFilters {
  return {
    text: overrides.text ?? "",
    severities: set(overrides.severities ?? []),
    hosts: set(overrides.hosts ?? []),
    services: set(overrides.services ?? []),
    categories: set(overrides.categories ?? []),
    waiverStates: set(overrides.waiverStates ?? []),
    coverageHosts: set(overrides.coverageHosts ?? []),
    coverageStates: set(overrides.coverageStates ?? []),
  };
}

function findingIds(result: FilteredDriftProjection): string[] {
  const ids: string[] = [];
  for (const group of result.findingGroups) {
    for (const subgroup of group.subgroups) {
      for (const finding of subgroup.findings) ids.push(finding.id);
    }
  }
  return ids;
}

function coverageHosts(result: FilteredDriftProjection): string[] {
  return result.coverageRows.map((row) => row.host);
}

describe("driftServiceFacetKey", () => {
  it("returns the exact JSON tuple encoding, host then service", () => {
    expect(driftServiceFacetKey({ host: "host-a.invalid", service: "svc-red" })).toBe(
      JSON.stringify(["host-a.invalid", "svc-red"]),
    );
    // Distinct hosts with the same service name never collide.
    expect(driftServiceFacetKey({ host: "x", service: "s" })).not.toBe(
      driftServiceFacetKey({ host: "y", service: "s" }),
    );
  });
});

describe("text search fields", () => {
  it.each([
    ["find-uno", ["find-uno"]],
    ["two", ["find-dos"]],
    ["gamma", ["find-cuatro"]],
    ["host-b", ["find-tres", "find-cuatro"]],
    ["svc-red", ["find-dos"]],
    ["/path/one", ["find-uno"]],
  ])("matches %s against exactly the id/message/category/host/service/path field", (text, expected) => {
    const result = filterDriftProjection(projection(), filters({ text: text as string }));
    expect(findingIds(result)).toEqual(expected);
  });

  it("is locale-independent case-folded and trims surrounding whitespace", () => {
    const result = filterDriftProjection(projection(), filters({ text: "  FIND-UNO  " }));
    expect(findingIds(result)).toEqual(["find-uno"]);
  });

  it("never searches waiver metadata or evidence", () => {
    // The active waiver reason/who ("r"/"w") must not surface find-cuatro.
    const result = filterDriftProjection(projection(), filters({ text: "who" }));
    expect(findingIds(result)).toEqual([]);
  });

  it("does not remove coverage rows for a finding text query", () => {
    const result = filterDriftProjection(projection(), filters({ text: "find-uno" }));
    expect(coverageHosts(result)).toEqual(["host-c.invalid", "host-a.invalid", "host-b.invalid"]);
  });
});

describe("finding facets", () => {
  it("severities union within the facet", () => {
    const result = filterDriftProjection(projection(), filters({ severities: ["error", "info"] }));
    expect(findingIds(result).sort()).toEqual(["find-cuatro", "find-tres", "find-uno"]);
  });

  it("hosts facet", () => {
    const result = filterDriftProjection(projection(), filters({ hosts: ["host-a.invalid"] }));
    expect(findingIds(result)).toEqual(["find-uno", "find-dos"]);
  });

  it("services facet matches the exact tuple and excludes host-level findings", () => {
    const key = driftServiceFacetKey({ host: "host-a.invalid", service: "svc-red" });
    const result = filterDriftProjection(projection(), filters({ services: [key] }));
    expect(findingIds(result)).toEqual(["find-dos"]);
  });

  it("categories facet", () => {
    const result = filterDriftProjection(projection(), filters({ categories: ["cat-alpha"] }));
    expect(findingIds(result).sort()).toEqual(["find-tres", "find-uno"]);
  });

  it("waiverStates facet distinguishes active from unwaived", () => {
    const active = filterDriftProjection(projection(), filters({ waiverStates: ["active"] }));
    expect(findingIds(active)).toEqual(["find-cuatro"]);
    const unwaived = filterDriftProjection(projection(), filters({ waiverStates: ["unwaived"] }));
    expect(findingIds(unwaived).sort()).toEqual(["find-dos", "find-tres", "find-uno"]);
  });
});

describe("coverage facets", () => {
  it("coverageHosts facet", () => {
    const result = filterDriftProjection(projection(), filters({ coverageHosts: ["host-a.invalid"] }));
    expect(coverageHosts(result)).toEqual(["host-a.invalid"]);
  });

  it("coverageStates union within the facet, preserving attention order", () => {
    const result = filterDriftProjection(projection(), filters({ coverageStates: ["fresh", "unreachable"] }));
    expect(coverageHosts(result)).toEqual(["host-c.invalid", "host-b.invalid"]);
  });
});

describe("composition and domain independence", () => {
  it("intersects facets across dimensions (error AND host-b)", () => {
    const result = filterDriftProjection(
      projection(),
      filters({ severities: ["error"], hosts: ["host-b.invalid"] }),
    );
    expect(findingIds(result)).toEqual(["find-cuatro"]);
  });

  it("finding filters never remove coverage rows and reuse the source coverage array", () => {
    const source = projection();
    const result = filterDriftProjection(source, filters({ severities: ["error"] }));
    expect(coverageHosts(result)).toEqual(["host-c.invalid", "host-a.invalid", "host-b.invalid"]);
    expect(result.coverageRows).toBe(source.coverageRows);
  });

  it("coverage filters never remove finding rows", () => {
    const result = filterDriftProjection(projection(), filters({ coverageStates: ["fresh"] }));
    expect(findingIds(result)).toEqual(["find-uno", "find-dos", "find-tres", "find-cuatro"]);
    expect(coverageHosts(result)).toEqual(["host-b.invalid"]);
  });

  it("a zero-match finding population does not imply zero coverage", () => {
    const result = filterDriftProjection(projection(), filters({ hosts: ["absent.invalid"] }));
    expect(result.filtered.findings).toBe(0);
    expect(result.filtered.coverageRows).toBe(3);
  });
});

describe("unknown selections", () => {
  it("returns a zero-match population without throwing", () => {
    const result = filterDriftProjection(
      projection(),
      filters({ categories: ["cat-none"], coverageStates: ["stale"] }),
    );
    expect(result.filtered.findings).toBe(0);
    expect(result.filtered.coverageRows).toBe(0);
    expect(result.hasActiveFilters).toBe(true);
  });
});

describe("order preservation", () => {
  it("preserves source host, subgroup, and finding order", () => {
    const result = filterDriftProjection(projection(), filters());
    expect(result.findingGroups.map((g) => g.host)).toEqual(["host-a.invalid", "host-b.invalid"]);
    expect(findingIds(result)).toEqual(["find-uno", "find-dos", "find-tres", "find-cuatro"]);
  });
});

describe("immutable references and freezing", () => {
  it("reuses every group, subgroup, and coverage array when no filter is active", () => {
    const source = projection();
    const result = filterDriftProjection(source, filters());
    expect(result.source).toBe(source);
    expect(result.total).toBe(source.summary);
    expect(result.coverageRows).toBe(source.coverageRows);
    expect(result.findingGroups[0]).toBe(source.findingGroups[0]);
    expect(result.findingGroups[1]).toBe(source.findingGroups[1]);
    expect(result.hasActiveFilters).toBe(false);
  });

  it("reuses surviving subgroup references and freezes only replacement shells", () => {
    const source = projection();
    const result = filterDriftProjection(source, filters({ severities: ["error"] }));
    // host-a: svc-red (warning) dropped, host-level (find-uno) survives intact.
    const hostA = result.findingGroups[0]!;
    expect(hostA).not.toBe(source.findingGroups[0]);
    expect(Object.isFrozen(hostA)).toBe(true);
    expect(Object.isFrozen(hostA.subgroups)).toBe(true);
    expect(hostA.subgroups[0]).toBe(source.findingGroups[0]!.subgroups[0]);
    // host-b: host-level (info) dropped, svc-blue (find-cuatro) survives intact.
    const hostB = result.findingGroups[1]!;
    expect(hostB.subgroups[0]).toBe(source.findingGroups[1]!.subgroups[1]);
  });

  it("freezes replacement group and subgroup shells", () => {
    const source = projection();
    // Only find-cuatro (host-b/svc-blue) matches, so host-a drops entirely and the
    // returned host-b group is a fresh frozen shell around a reused subgroup.
    const result = filterDriftProjection(source, filters({ text: "find-cuatro" }));
    const group = result.findingGroups[0]!;
    expect(Object.isFrozen(group)).toBe(true);
    expect(Object.isFrozen(group.subgroups)).toBe(true);
    expect(Object.isFrozen(group.subgroups[0]!.findings)).toBe(true);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.findingGroups)).toBe(true);
    expect(Object.isFrozen(result.filtered)).toBe(true);
  });
});

describe("count invariants", () => {
  it("filtered counts match returned references and totals stay complete", () => {
    const source = projection();
    const result = filterDriftProjection(source, filters({ severities: ["error"] }));
    expect(result.filtered.findings).toBe(findingIds(result).length);
    expect(result.filtered.hostsWithFindings).toBe(result.findingGroups.length);
    expect(result.filtered.coverageRows).toBe(result.coverageRows.length);
    // Complete-generation totals are unaffected by filtering.
    expect(result.total.totalFindings).toBe(4);
    expect(result.total.totalHosts).toBe(3);
  });
});

describe("source and set non-mutation", () => {
  it("snapshots supplied sets so later mutation cannot change the result", () => {
    const severities = new Set<string>(["error"]);
    const result = filterDriftProjection(projection(), {
      ...filters(),
      severities: severities as unknown as DriftFilters["severities"],
    });
    const before = findingIds(result);
    severities.add("warning");
    severities.clear();
    expect(findingIds(result)).toEqual(before);
  });

  it("does not mutate the caller's sets", () => {
    const hosts = new Set<string>(["host-a.invalid"]);
    filterDriftProjection(projection(), {
      ...filters(),
      hosts: hosts as unknown as DriftFilters["hosts"],
    });
    expect([...hosts]).toEqual(["host-a.invalid"]);
  });

  it("does not mutate the source projection arrays", () => {
    const source = projection();
    const beforeGroups = source.findingGroups.length;
    const beforeRows = source.coverageRows.length;
    filterDriftProjection(source, filters({ severities: ["error"], coverageStates: ["fresh"] }));
    expect(source.findingGroups.length).toBe(beforeGroups);
    expect(source.coverageRows.length).toBe(beforeRows);
    expect(findingIds(filterDriftProjection(source, filters()))).toEqual([
      "find-uno",
      "find-dos",
      "find-tres",
      "find-cuatro",
    ]);
  });
});

describe("invalid projection", () => {
  it("throws the fixed INVALID_INPUT error for an incomplete projection", () => {
    try {
      filterDriftProjection({} as DriftProjection, filters());
      throw new Error("expected throw");
    } catch (error) {
      expect(error).toBeInstanceOf(DriftProjectionError);
      expect((error as DriftProjectionError).code).toBe("INVALID_INPUT");
      expect((error as DriftProjectionError).message).toBe("Drift filters require a complete projection.");
    }
  });
});
