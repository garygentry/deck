import { describe, expect, it } from "vitest";
import type { InventoryModel } from "../../../inventory/web/model.js";
import { isIconName, type StatusPresentation } from "@/ui/index.js";
import {
  DRIFT_COVERAGE,
  DRIFT_SEVERITY,
  DRIFT_UNRESOLVED_LOCATION,
  DRIFT_WAIVER,
  nextProgressiveCount,
} from "../../web/constants.js";
import {
  driftScopeHref,
  parseDriftScope,
  resolveDriftScope,
  type DriftEntityScope,
  type DriftScopeResult,
} from "../../web/scope.js";

// Drift's keyboard grammar now runs on the shared `useListNavigation` resolver;
// its intent cases live in `ui-list-navigation.test.ts` ("ported: drift keys").
// This suite keeps the feature-owned pure pieces: URL scope, the presentation
// maps and progressive counting.

// ---------------------------------------------------------------------------
// Fixtures — all identities are invented `.invalid` entities, never estate facts.
// ---------------------------------------------------------------------------

/** Build a minimal model whose only meaningful data is the identity indexes. */
function makeModel(
  hostNames: readonly string[],
  services: readonly (readonly [string, string])[],
): InventoryModel {
  const hostByName = new Map(hostNames.map((name) => [name, { key: name }]));
  const serviceByHost = new Map<string, Map<string, unknown>>();
  for (const [host, name] of services) {
    let inner = serviceByHost.get(host);
    if (inner === undefined) {
      inner = new Map();
      serviceByHost.set(host, inner);
    }
    inner.set(name, { key: { host, name } });
  }
  return {
    hosts: [],
    services: [],
    hostByName,
    serviceByHost,
  } as unknown as InventoryModel;
}

// ---------------------------------------------------------------------------
// Scope: href/parse round trips.
// ---------------------------------------------------------------------------

describe("driftScopeHref / parseDriftScope round trips", () => {
  const cases: readonly DriftEntityScope[] = [
    { host: "compute-a.invalid" },
    { host: "compute-a.invalid", service: "api" },
    { host: "host with spaces.invalid" },
    { host: "reserved.invalid", service: "a b&c=d?e#f" },
    { host: "café-δ.invalid", service: "sérvïce-Ω" },
    { host: "100% pure.invalid", service: "path/to+thing" },
  ];

  for (const scope of cases) {
    it(`round-trips ${JSON.stringify(scope)}`, () => {
      const href = driftScopeHref(scope);
      expect(href.startsWith("/drift?")).toBe(true);
      const result = parseDriftScope(href);
      expect(result.status).toBe("scoped");
      if (result.status !== "scoped") return;
      expect(result.scope.host).toBe(scope.host);
      expect(result.scope.service).toBe(scope.service);
    });
  }

  it("omits the service parameter for a host-only scope", () => {
    expect(driftScopeHref({ host: "h.invalid" })).toBe("/drift?host=h.invalid");
  });

  it("includes both parameters for a service scope, host first", () => {
    expect(driftScopeHref({ host: "h.invalid", service: "svc" })).toBe(
      "/drift?host=h.invalid&service=svc",
    );
  });
});

// ---------------------------------------------------------------------------
// Scope: recoverable parse errors and syntactic classification.
// ---------------------------------------------------------------------------

describe("parseDriftScope classification", () => {
  it("returns unscoped for an empty query", () => {
    expect(parseDriftScope("/drift").status).toBe("unscoped");
    expect(parseDriftScope("").status).toBe("unscoped");
    expect(parseDriftScope("/drift?").status).toBe("unscoped");
  });

  it("ignores unrelated keys", () => {
    const result = parseDriftScope("/drift?foo=bar&host=h.invalid&baz=1");
    expect(result.status).toBe("scoped");
    if (result.status === "scoped") {
      expect(result.scope.host).toBe("h.invalid");
      expect(result.scope.service).toBeUndefined();
    }
  });

  it("excludes a #fragment from the query", () => {
    const result = parseDriftScope("/drift?host=h.invalid#section?host=other");
    expect(result.status).toBe("scoped");
    if (result.status === "scoped") expect(result.scope.host).toBe("h.invalid");
  });

  it("detects malformed percent encoding before URLSearchParams masks it", () => {
    for (const raw of ["/drift?host=%ZZ", "/drift?host=%", "/drift?service=a%2", "/drift?host=%E0%A4"]) {
      const result = parseDriftScope(raw);
      expect(result.status).toBe("no-match");
      if (result.status === "no-match") expect(result.code).toBe("MALFORMED_ENCODING");
    }
  });

  it("rejects duplicate host or service parameters", () => {
    for (const raw of ["/drift?host=a.invalid&host=b.invalid", "/drift?host=a.invalid&service=x&service=y"]) {
      const result = parseDriftScope(raw);
      expect(result.status).toBe("no-match");
      if (result.status === "no-match") expect(result.code).toBe("DUPLICATE_VALUE");
    }
  });

  it("rejects empty host or service values", () => {
    for (const raw of ["/drift?host=", "/drift?host=h.invalid&service="]) {
      const result = parseDriftScope(raw);
      expect(result.status).toBe("no-match");
      if (result.status === "no-match") expect(result.code).toBe("EMPTY_VALUE");
    }
  });

  it("rejects a service without a host", () => {
    const result = parseDriftScope("/drift?service=api");
    expect(result.status).toBe("no-match");
    if (result.status === "no-match") expect(result.code).toBe("SERVICE_WITHOUT_HOST");
  });

  it("prefers empty-value over service-without-host for an empty service", () => {
    const result = parseDriftScope("/drift?service=");
    expect(result.status).toBe("no-match");
    if (result.status === "no-match") expect(result.code).toBe("EMPTY_VALUE");
  });

  it("never throws for hostile user input", () => {
    for (const raw of ["/drift?host=%%%", "/drift?=&=&", "/drift?host=a&host=b&host=c", "￿"]) {
      expect(() => parseDriftScope(raw)).not.toThrow();
    }
  });

  it("carries a fixed sanitized message on every no-match", () => {
    const result = parseDriftScope("/drift?service=api");
    if (result.status === "no-match") {
      expect(result.message.length).toBeGreaterThan(0);
      expect(result.message).not.toContain("api");
    }
  });
});

// ---------------------------------------------------------------------------
// Scope: resolution against an inventory model.
// ---------------------------------------------------------------------------

describe("resolveDriftScope", () => {
  const model = makeModel(
    ["known-host.invalid", "lonely-host.invalid"],
    [["known-host.invalid", "known-service"]],
  );

  it("passes unscoped through unchanged", () => {
    const parsed = parseDriftScope("/drift");
    expect(resolveDriftScope(parsed, model)).toBe(parsed);
  });

  it("passes a no-match through unchanged", () => {
    const parsed = parseDriftScope("/drift?service=orphan");
    expect(resolveDriftScope(parsed, model)).toBe(parsed);
  });

  it("resolves a known host scope", () => {
    const parsed = parseDriftScope("/drift?host=known-host.invalid");
    const resolved = resolveDriftScope(parsed, model);
    expect(resolved.status).toBe("scoped");
    if (resolved.status === "scoped") expect(resolved.scope.host).toBe("known-host.invalid");
  });

  it("resolves a known (host, service) scope", () => {
    const parsed = parseDriftScope("/drift?host=known-host.invalid&service=known-service");
    const resolved = resolveDriftScope(parsed, model);
    expect(resolved.status).toBe("scoped");
    if (resolved.status === "scoped") expect(resolved.scope.service).toBe("known-service");
  });

  it("reports an unknown host as UNKNOWN_ENTITY", () => {
    const parsed = parseDriftScope("/drift?host=ghost.invalid");
    const resolved = resolveDriftScope(parsed, model);
    expect(resolved.status).toBe("no-match");
    if (resolved.status === "no-match") expect(resolved.code).toBe("UNKNOWN_ENTITY");
  });

  it("reports an unknown service on a known host as UNKNOWN_ENTITY", () => {
    const parsed = parseDriftScope("/drift?host=known-host.invalid&service=ghost");
    const resolved = resolveDriftScope(parsed, model);
    expect(resolved.status).toBe("no-match");
    if (resolved.status === "no-match") expect(resolved.code).toBe("UNKNOWN_ENTITY");
  });

  it("reports a service on an unrelated host as UNKNOWN_ENTITY", () => {
    const parsed = parseDriftScope("/drift?host=lonely-host.invalid&service=known-service");
    const resolved = resolveDriftScope(parsed, model);
    expect(resolved.status).toBe("no-match");
    if (resolved.status === "no-match") expect(resolved.code).toBe("UNKNOWN_ENTITY");
  });

  it("never throws for any parsed result", () => {
    const results: DriftScopeResult[] = [
      parseDriftScope("/drift"),
      parseDriftScope("/drift?host=ghost.invalid"),
      parseDriftScope("/drift?host=%ZZ"),
    ];
    for (const parsed of results) {
      expect(() => resolveDriftScope(parsed, model)).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// Presentation maps.
// ---------------------------------------------------------------------------

describe("presentation maps", () => {
  function assertCell(cell: StatusPresentation): void {
    expect(cell.label.length).toBeGreaterThan(0);
    expect(isIconName(cell.icon)).toBe(true);
    expect(cell.tone.length).toBeGreaterThan(0);
  }

  it("covers every severity exhaustively", () => {
    expect(Object.keys(DRIFT_SEVERITY).sort()).toEqual(["error", "info", "warning"]);
    for (const cell of Object.values(DRIFT_SEVERITY)) assertCell(cell);
    expect(DRIFT_SEVERITY.error.label).toBe("Error");
    expect(DRIFT_SEVERITY.warning.label).toBe("Warning");
    expect(DRIFT_SEVERITY.info.label).toBe("Info");
    expect(DRIFT_SEVERITY.error.tone).toBe("danger");
  });

  it("covers every waiver state exhaustively", () => {
    expect(Object.keys(DRIFT_WAIVER).sort()).toEqual(["active", "expired", "unwaived"]);
    for (const cell of Object.values(DRIFT_WAIVER)) assertCell(cell);
    expect(DRIFT_WAIVER.unwaived.label).toBe("Unwaived");
    expect(DRIFT_WAIVER.active.label).toBe("Active waiver");
    expect(DRIFT_WAIVER.expired.label).toBe("Expired waiver");
    // An expired waiver counts as active risk, so it reads as attention.
    expect(DRIFT_WAIVER.expired.tone).toBe("warn");
  });

  it("covers all five coverage states exhaustively", () => {
    expect(Object.keys(DRIFT_COVERAGE).sort()).toEqual([
      "fresh",
      "never-collected",
      "partial",
      "stale",
      "unreachable",
    ]);
    for (const cell of Object.values(DRIFT_COVERAGE)) assertCell(cell);
    expect(DRIFT_COVERAGE["never-collected"].label).toBe("Never collected");
    expect(DRIFT_COVERAGE.unreachable.label).toBe("Unreachable");
    expect(DRIFT_COVERAGE.unreachable.tone).toBe("danger");
  });

  it("supplies an unresolved-location cell with the fixed phrase", () => {
    assertCell(DRIFT_UNRESOLVED_LOCATION);
    expect(DRIFT_UNRESOLVED_LOCATION.label).toBe(
      "Location unresolved; no host or service detail link is available.",
    );
  });

  it("freezes the presentation maps and their cells", () => {
    expect(Object.isFrozen(DRIFT_SEVERITY)).toBe(true);
    expect(Object.isFrozen(DRIFT_SEVERITY.error)).toBe(true);
    expect(Object.isFrozen(DRIFT_COVERAGE["never-collected"])).toBe(true);
    expect(Object.isFrozen(DRIFT_UNRESOLVED_LOCATION)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Progressive counting.
// ---------------------------------------------------------------------------

describe("nextProgressiveCount", () => {
  it("advances by the fixed step of 25", () => {
    expect(nextProgressiveCount(0, 100)).toBe(25);
    expect(nextProgressiveCount(25, 100)).toBe(50);
    expect(nextProgressiveCount(50, 100)).toBe(75);
  });

  it("clamps to the total and never exceeds it", () => {
    expect(nextProgressiveCount(90, 100)).toBe(100);
    expect(nextProgressiveCount(100, 100)).toBe(100);
    expect(nextProgressiveCount(30, 10)).toBe(10);
    expect(nextProgressiveCount(0, 0)).toBe(0);
  });

  it("throws a fixed RangeError for negative or non-safe-integer counts", () => {
    for (const [current, total] of [
      [-1, 10],
      [0, -1],
      [1.5, 10],
      [0, Number.NaN],
      [0, Number.POSITIVE_INFINITY],
      [Number.MAX_SAFE_INTEGER + 1, 10],
    ] as const) {
      expect(() => nextProgressiveCount(current, total)).toThrowError(
        new RangeError("Progressive counts must be non-negative safe integers."),
      );
    }
  });
});
