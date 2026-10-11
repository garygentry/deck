import { describe, expect, it } from "vitest";
import { validateSnapshot } from "../src/index.js";

const observedHost = (name: string) => ({
  name,
  coverage: "collected",
  collectedAt: "2026-01-01T00:00:00Z",
});

const drift = (id: string, host: string, service?: string, until?: string) => ({
  id,
  severity: "warning",
  location: { host, ...(service === undefined ? {} : { service }) },
  category: "configuration",
  message: "invented drift",
  ...(until === undefined ? {} : { waiver: { reason: "accepted", who: "operator", until } }),
});

const codes = (result: ReturnType<typeof validateSnapshot>) => result.findings.map((item) => item.code);

describe("validateSnapshot", () => {
  it.each([
    ["generatedAt", { schemaVersion: 1, generatedAt: "2026-99-99T99:99:99Z" }],
    ["collectedAt", { schemaVersion: 1, generatedAt: "2026-01-01T00:00:00Z", hosts: [{ name: "alpha", coverage: "collected", collectedAt: "2025-02-29T00:00:00Z" }] }],
    ["waiver.until", { schemaVersion: 1, generatedAt: "2026-01-01T00:00:00Z", drift: [drift("one", "alpha", undefined, "2026-01-01T00:00:00+24:00")] }],
  ])("rejects an impossible %s timestamp", (_field, snapshot) => {
    expect(codes(validateSnapshot(snapshot))).toContain("SCHEMA_INVALID");
  });

  it.each([
    "2024-02-29T23:59:59Z",
    "2026-01-01T12:34:56.789+05:30",
    "2026-01-01T00:00:00-08:00",
  ])("accepts the valid RFC 3339 timestamp %s", (generatedAt) => {
    expect(validateSnapshot({ schemaVersion: 1, generatedAt })).toEqual({
      classification: 0,
      findings: [],
      summary: { error: 0, warning: 0, info: 0 },
    });
  });

  it("shape-checks snapshots and detects duplicate identities without a config", () => {
    expect(validateSnapshot({ schemaVersion: 1 })).toMatchObject({ classification: 1, findings: [{ code: "SCHEMA_REQUIRED_MISSING" }] });
    const result = validateSnapshot({
      schemaVersion: 1,
      generatedAt: "2026-01-01T00:00:00Z",
      hosts: [observedHost("alpha"), observedHost("alpha")],
      services: [
        { host: "alpha", name: "api", state: "running" },
        { host: "alpha", name: "api", state: "stopped" },
      ],
      drift: [drift("same", "alpha"), drift("same", "alpha")],
    });
    expect(codes(result)).toEqual(expect.arrayContaining([
      "SNAPSHOT_HOST_DUPLICATE",
      "SNAPSHOT_SERVICE_DUPLICATE",
      "DRIFT_ID_DUPLICATE",
    ]));
  });

  it("cross-checks observations, drift locations, and hidden uncollected hosts", () => {
    const config = {
      schemaVersion: 2,
      estate: { name: "invented" },
      hosts: [
        { name: "alpha", kind: "vm", purpose: "test" },
        { name: "hidden", kind: "vm", purpose: "test", hidden: true },
      ],
      services: [{ host: "alpha", name: "api", kind: "systemd", purpose: "test" }],
    };
    const result = validateSnapshot({
      schemaVersion: 1,
      generatedAt: "2026-01-01T00:00:00Z",
      hosts: [observedHost("alpha"), observedHost("unknown")],
      services: [{ host: "alpha", name: "missing", state: "unknown" }],
      drift: [drift("one", "alpha", "missing")],
    }, config);
    expect(codes(result)).toEqual(expect.arrayContaining([
      "SNAPSHOT_HOST_UNDECLARED",
      "SNAPSHOT_SERVICE_UNDECLARED",
      "DRIFT_LOCATION_UNRESOLVED",
      "HOST_NOT_COLLECTED",
    ]));
    expect(result.findings).toContainEqual(expect.objectContaining({ code: "HOST_NOT_COLLECTED", path: "/hosts", severity: "info", message: expect.stringContaining("hidden") }));
  });

  it("distinguishes config argument errors and does not evaluate waiver expiry", () => {
    const snapshot = {
      schemaVersion: 1,
      generatedAt: "2026-01-01T00:00:00Z",
      hosts: [observedHost("alpha")],
      drift: [drift("one", "alpha", undefined, "2000-01-01T00:00:00Z")],
    };
    expect(validateSnapshot(snapshot, null)).toMatchObject({ classification: 2, toolError: { code: "INPUT_NOT_OBJECT" } });
    expect(validateSnapshot(snapshot, {})).toMatchObject({ classification: 2, toolError: { code: "CONFIG_UNSUPPORTED" } });
    expect(validateSnapshot(snapshot, { schemaVersion: 99 })).toMatchObject({ classification: 2, toolError: { code: "CONFIG_UNSUPPORTED" } });
    expect(validateSnapshot(snapshot, { schemaVersion: 2, estate: { name: "invented" }, hosts: [{ name: "alpha", kind: "vm", purpose: "test" }] })).toEqual({ classification: 0, findings: [], summary: { error: 0, warning: 0, info: 0 } });
  });
});
