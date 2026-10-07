import { describe, expect, it } from "vitest";
import { validate } from "../src/index.js";

const host = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  kind: "vm",
  purpose: "test host",
  ...extra,
});

const service = (hostName: string, name: string, extra: Record<string, unknown> = {}) => ({
  host: hostName,
  name,
  kind: "systemd",
  purpose: "test service",
  ...extra,
});

const codes = (result: ReturnType<typeof validate>) => result.findings.map((item) => item.code);

describe("validate semantic rules", () => {
  it("detects duplicate host, service-pair, and collection identities", () => {
    const result = validate({
      schemaVersion: 1,
      estate: { name: "test" },
      hosts: [host("alpha"), host("alpha", { hidden: true })],
      services: [service("alpha", "api"), service("alpha", "api", { hidden: true })],
      groups: [
        { id: "same", title: "one", items: [] },
        { id: "two", title: "two", items: [{ type: "group", id: "same", title: "nested", items: [] }] },
      ],
    });
    expect(codes(result)).toEqual(expect.arrayContaining(["HOST_DUPLICATE", "SERVICE_DUPLICATE", "ID_DUPLICATE"]));
    expect(validate({ schemaVersion: 1, estate: { name: "test" }, hosts: [host("alpha")], services: [service("alpha", "api"), service("alpha", "web")] }).classification).toBe(0);
  });

  it("checks references while treating hidden entities as valid targets", () => {
    const valid = {
      schemaVersion: 1,
      estate: { name: "test" },
      hosts: [host("alpha", { hidden: true })],
      services: [service("alpha", "api", { hidden: true })],
      groups: [{ id: "main", title: "main", items: [{ type: "service", host: "alpha", name: "api" }] }],
    };
    expect(validate(valid).classification).toBe(0);
    const invalid = structuredClone(valid);
    invalid.groups[0]!.items[0]!.name = "missing";
    expect(validate(invalid)).toMatchObject({ classification: 1, findings: [{ code: "REF_SERVICE_UNRESOLVED", path: "/groups/0/items/0" }] });
    expect(codes(validate({ schemaVersion: 1, estate: { name: "test" }, services: [service("missing", "api")] }))).toContain("REF_HOST_UNRESOLVED");
  });

  it("enforces layer ownership and permits both/container/identity overlay keys", () => {
    const base = { schemaVersion: 1, estate: { name: "test" }, hosts: [host("alpha")], services: [service("alpha", "api")] };
    const overlay = { schemaVersion: 1, estate: {}, hosts: [{ name: "alpha", hidden: true }], services: [{ host: "alpha", name: "api", links: [{ title: "API", href: "https://example.invalid" }] }] };
    expect(validate(overlay, { layer: "overlay", base })).toEqual({ classification: 0, findings: [], summary: { error: 0, warning: 0, info: 0 } });
    expect(validate({ schemaVersion: 1 }, { layer: "overlay" }).classification).toBe(0);
    expect(codes(validate({ schemaVersion: 1, hosts: [{ name: "alpha", kind: "vm" }] }, { layer: "overlay", base }))).toContain("LAYER_BASE_KEY_IN_OVERLAY");
    expect(codes(validate({ ...base, hosts: [host("alpha", { hidden: true })] }, { layer: "base" }))).toContain("LAYER_OVERLAY_KEY_IN_BASE");
    expect(codes(validate({ schemaVersion: 1, hosts: [{ name: "missing", hidden: true }] }, { layer: "overlay", base }))).toContain("OVERLAY_DANGLING_REF");
    expect(codes(validate({ ...base, hosts: [host("alpha", { hidden: true })] }))).not.toContain("LAYER_OVERLAY_KEY_IN_BASE");
  });

  it("enforces layer ownership for empty containers", () => {
    const base = { schemaVersion: 1, estate: { name: "test" }, hosts: [host("alpha")], services: [service("alpha", "api")] };

    expect(codes(validate({ ...base, groups: [] }, { layer: "base" }))).toContain("LAYER_OVERLAY_KEY_IN_BASE");
    expect(codes(validate({ ...base, hosts: [host("alpha", { links: [] })] }, { layer: "base" }))).toContain("LAYER_OVERLAY_KEY_IN_BASE");
    expect(codes(validate({ schemaVersion: 1, hosts: [{ name: "alpha", addresses: [] }] }, { layer: "overlay", base }))).toContain("LAYER_BASE_KEY_IN_OVERLAY");

    const carvedOut = { schemaVersion: 1, estate: {}, hosts: [], services: [] };
    expect(validate(carvedOut, { layer: "overlay", base })).toEqual({ classification: 0, findings: [], summary: { error: 0, warning: 0, info: 0 } });
    expect(validate({ schemaVersion: 1, hosts: [{ name: "alpha" }] }, { layer: "overlay", base })).toEqual({ classification: 0, findings: [], summary: { error: 0, warning: 0, info: 0 } });
  });

  it("reports unknown provider kinds and honours knownKinds", () => {
    const document = { schemaVersion: 1, estate: { name: "test" }, hosts: [host("alpha", { bindings: { custom: {} } })] };
    expect(codes(validate(document))).toContain("PROVIDER_KIND_UNKNOWN");
    expect(validate(document, { knownKinds: ["custom"] }).classification).toBe(0);
    expect(validate({ schemaVersion: 1, estate: { name: "test" }, hosts: [host("alpha", { bindings: { docker: {} } })] }).classification).toBe(0);
    expect(validate({ schemaVersion: 1, estate: { name: "test" }, hosts: [host("alpha", { bindings: { "http-health": { url: "https://alpha.invalid/health" } } })] }).classification).toBe(0);
  });

  it("finds credential values and token shapes without echoing suspect values", () => {
    const suspect = "AKIA1234567890ABCDEF";
    const result = validate({ schemaVersion: 1, estate: { name: "test", domains: { lan: "example.invalid" } }, integrations: [{ id: "one", kind: "link", title: "one", baseUrl: "https://example.invalid", card: { api_key: "not a reference!", note: suspect } }] });
    expect(codes(result).filter((code) => code === "SECRET_VALUE_SUSPECTED")).toHaveLength(2);
    expect(JSON.stringify(result)).not.toContain(suspect);
    expect(validate({ schemaVersion: 1, estate: { name: "test" }, integrations: [{ id: "one", kind: "link", title: "one", baseUrl: "https://example.invalid", card: { api_key: "secret.ref" } }] }).classification).toBe(0);
  });

  it("returns stable ordering and covers every validation gate without throwing", () => {
    const document = { schemaVersion: 1, estate: { name: "test" }, hosts: [host("z"), host("z")], integrations: [{ id: "x", kind: "unknown", title: "x", baseUrl: "https://example.invalid" }] };
    expect(JSON.stringify(validate(document))).toBe(JSON.stringify(validate(document)));
    expect(validate(null)).toMatchObject({ classification: 2, toolError: { code: "INPUT_NOT_OBJECT" } });
    expect(validate([])).toMatchObject({ classification: 2, toolError: { code: "INPUT_NOT_OBJECT" } });
    expect(validate({ schemaVersion: "1" })).toMatchObject({ classification: 2, toolError: { code: "VERSION_UNREADABLE" } });
    expect(validate({ schemaVersion: 99 })).toMatchObject({ classification: 1, findings: [{ code: "VERSION_UNSUPPORTED" }] });
    const hostile = new Proxy({}, { get() { throw new Error("hostile input"); } });
    expect(() => validate(hostile)).not.toThrow();
    expect(validate(hostile)).toMatchObject({ classification: 2, toolError: { code: "INTERNAL" } });
    for (const garbage of [undefined, true, 1, "text", {}, { schemaVersion: 1 }, { schemaVersion: 1, estate: null }]) {
      expect(() => validate(garbage)).not.toThrow();
    }
  });
});
