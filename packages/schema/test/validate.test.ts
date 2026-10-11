import { describe, expect, it } from "vitest";
import { composeFixtures } from "../src/fixtures/modules.js";
import { BUILTIN_CONTRIBUTIONS, composeConfig, validate } from "../src/index.js";

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
      schemaVersion: 2,
      estate: { name: "test" },
      hosts: [host("alpha"), host("alpha", { hidden: true })],
      services: [service("alpha", "api"), service("alpha", "api", { hidden: true })],
      integrations: [{ id: "same", kind: "link", title: "one", baseUrl: "https://one.invalid" }, { id: "same", kind: "link", title: "two", baseUrl: "https://two.invalid" }],
    });
    expect(codes(result)).toEqual(expect.arrayContaining(["HOST_DUPLICATE", "SERVICE_DUPLICATE", "ID_DUPLICATE"]));
    expect(validate({ schemaVersion: 2, estate: { name: "test" }, hosts: [host("alpha")], services: [service("alpha", "api"), service("alpha", "web")] }).classification).toBe(0);
  });

  it("checks references while treating hidden entities as valid targets", () => {
    const valid = {
      schemaVersion: 2,
      estate: { name: "test" },
      hosts: [host("alpha", { hidden: true })],
      services: [service("alpha", "api", { hidden: true })],
      sources: [{ id: "notes", kind: "markdown-tree", title: "Notes", location: { path: "/srv/notes" }, owner: { host: "alpha", service: "api" } }],
    };
    expect(validate(valid).classification).toBe(0);
    const invalid = structuredClone(valid);
    invalid.sources[0]!.owner.service = "missing";
    expect(validate(invalid)).toMatchObject({ classification: 1, findings: [{ code: "REF_SERVICE_UNRESOLVED", path: "/sources/0/owner/service" }] });
    expect(codes(validate({ schemaVersion: 2, estate: { name: "test" }, services: [service("missing", "api")] }))).toContain("REF_HOST_UNRESOLVED");
  });

  it("enforces layer ownership and permits both/container/identity overlay keys", () => {
    const base = { schemaVersion: 2, estate: { name: "test" }, hosts: [host("alpha")], services: [service("alpha", "api")] };
    const overlay = { schemaVersion: 2, estate: {}, hosts: [{ name: "alpha", hidden: true }], services: [{ host: "alpha", name: "api", links: [{ title: "API", href: "https://example.invalid" }] }] };
    expect(validate(overlay, { layer: "overlay", base })).toEqual({ classification: 0, findings: [], summary: { error: 0, warning: 0, info: 0 } });
    expect(validate({ schemaVersion: 2 }, { layer: "overlay" }).classification).toBe(0);
    expect(codes(validate({ schemaVersion: 2, hosts: [{ name: "alpha", kind: "vm" }] }, { layer: "overlay", base }))).toContain("LAYER_BASE_KEY_IN_OVERLAY");
    expect(codes(validate({ ...base, hosts: [host("alpha", { hidden: true })] }, { layer: "base" }))).toContain("LAYER_OVERLAY_KEY_IN_BASE");
    expect(codes(validate({ schemaVersion: 2, hosts: [{ name: "missing", hidden: true }] }, { layer: "overlay", base }))).toContain("OVERLAY_DANGLING_REF");
    expect(codes(validate({ ...base, hosts: [host("alpha", { hidden: true })] }))).not.toContain("LAYER_OVERLAY_KEY_IN_BASE");
  });

  it("enforces layer ownership for empty containers", () => {
    const base = { schemaVersion: 2, estate: { name: "test" }, hosts: [host("alpha")], services: [service("alpha", "api")] };

    expect(codes(validate({ ...base, hosts: [host("alpha", { links: [] })] }, { layer: "base" }))).toContain("LAYER_OVERLAY_KEY_IN_BASE");
    expect(codes(validate({ schemaVersion: 2, hosts: [{ name: "alpha", addresses: [] }] }, { layer: "overlay", base }))).toContain("LAYER_BASE_KEY_IN_OVERLAY");

    const carvedOut = { schemaVersion: 2, estate: {}, hosts: [], services: [] };
    expect(validate(carvedOut, { layer: "overlay", base })).toEqual({ classification: 0, findings: [], summary: { error: 0, warning: 0, info: 0 } });
    expect(validate({ schemaVersion: 2, hosts: [{ name: "alpha" }] }, { layer: "overlay", base })).toEqual({ classification: 0, findings: [], summary: { error: 0, warning: 0, info: 0 } });
  });

  it("reports provider kinds no contribution declares", () => {
    const document = { schemaVersion: 2, estate: { name: "test" }, hosts: [host("alpha", { bindings: { custom: {} } })] };
    expect(codes(validate(document))).toContain("PROVIDER_KIND_UNKNOWN");
    const composed = composeConfig([...BUILTIN_CONTRIBUTIONS, { id: "custom-source", providerKinds: [{ kind: "custom", bindable: true }] }]);
    expect(validate(document, { composed }).classification).toBe(0);
    // The data-source modules' kinds are known once composed (the fixture stand-in here).
    const withSources = { composed: composeFixtures() };
    expect(codes(validate({ schemaVersion: 2, estate: { name: "test" }, hosts: [host("alpha", { bindings: { docker: {} } })] }))).toContain("PROVIDER_KIND_UNKNOWN");
    expect(validate({ schemaVersion: 2, estate: { name: "test" }, hosts: [host("alpha", { bindings: { docker: {} } })] }, withSources).classification).toBe(0);
    expect(validate({ schemaVersion: 2, estate: { name: "test" }, hosts: [host("alpha", { bindings: { "http-health": { url: "https://alpha.invalid/health" } } })] }, withSources).classification).toBe(0);
  });

  it("the fixture stand-in checks docker and gatus instances against their instance schemas", () => {
    const docker = { id: "docker", kind: "docker", title: "Docker", baseUrl: "http://proxy" };
    const doc = (instance: Record<string, unknown>) => ({ schemaVersion: 2, estate: { name: "test" }, integrations: [instance] });
    expect(validate(doc(docker), { composed: composeFixtures() }).classification).toBe(0);
    expect(codes(validate(doc({ ...docker, surprise: true }), { composed: composeFixtures() }))).toContain("SCHEMA_UNKNOWN_PROPERTY");
    expect(codes(validate(doc({ ...docker, kind: "gatus", baseUrl: undefined }), { composed: composeFixtures() }))).toContain("SCHEMA_REQUIRED_MISSING");
  });

  it("reports a kind only an off module declares as PROVIDER_KIND_DISABLED: info by default, warning when strict", () => {
    const composed = composeConfig([...BUILTIN_CONTRIBUTIONS, { id: "feeds", disabled: "not enabled", providerKinds: [{ kind: "feed" }] }]);
    const document = {
      schemaVersion: 2,
      estate: { name: "test" },
      hosts: [host("alpha", { bindings: { feed: {} } })],
      integrations: [{ id: "f", kind: "feed", title: "Feed", baseUrl: "https://feed.invalid" }],
    };
    const advisory = validate(document, { composed });
    expect(advisory.classification).toBe(0);
    expect(advisory.findings.map(({ code, path, severity }) => ({ code, path, severity }))).toEqual([
      { code: "PROVIDER_KIND_DISABLED", path: "/hosts/0/bindings/feed", severity: "info" },
      { code: "PROVIDER_KIND_DISABLED", path: "/integrations/0/kind", severity: "info" },
    ]);
    expect(advisory.findings[0]!.message).toContain('module "feeds"');
    const strict = validate(document, { composed, disabledSections: "strict" });
    expect(strict.classification).toBe(1);
    expect(strict.findings.map(({ severity }) => severity)).toEqual(["warning", "warning"]);
    // A kind nobody declares stays PROVIDER_KIND_UNKNOWN; one an enabled module also declares is known.
    expect(codes(validate({ ...document, hosts: [host("alpha", { bindings: { other: {} } })], integrations: [] }, { composed }))).toEqual(["PROVIDER_KIND_UNKNOWN"]);
    const both = composeConfig([...BUILTIN_CONTRIBUTIONS, { id: "feeds", disabled: "off", providerKinds: [{ kind: "feed" }] }, { id: "feeds-two", providerKinds: [{ kind: "feed", bindable: true }] }]);
    expect(validate(document, { composed: both }).findings).toEqual([]);
  });

  it("reports a binding of a declared kind that is not bindable", () => {
    const composed = composeConfig([...BUILTIN_CONTRIBUTIONS, { id: "feeds", providerKinds: [{ kind: "feed" }, { kind: "tap", bindable: true }] }]);
    const document = { schemaVersion: 2, estate: { name: "test" }, hosts: [host("alpha", { bindings: { feed: {}, tap: {}, mystery: {} } })] };
    expect(validate(document, { composed }).findings.map(({ code, path, severity }) => ({ code, path, severity }))).toEqual([
      { code: "PROVIDER_BINDING_UNSUPPORTED", path: "/hosts/0/bindings/feed", severity: "info" },
      { code: "PROVIDER_KIND_UNKNOWN", path: "/hosts/0/bindings/mystery", severity: "warning" },
    ]);
    // An integration of a non-bindable kind is fine: the flag is about bindings only.
    const integration = { id: "f", kind: "feed", title: "Feed", baseUrl: "https://feed.invalid" };
    expect(validate({ schemaVersion: 2, estate: { name: "test" }, integrations: [integration] }, { composed }).classification).toBe(0);
  });

  it("finds credential values and token shapes without echoing suspect values", () => {
    const suspect = "AKIA1234567890ABCDEF";
    const result = validate({ schemaVersion: 2, estate: { name: "test", domains: { lan: "example.invalid" } }, integrations: [{ id: "one", kind: "prometheus", title: "one", baseUrl: "https://example.invalid", card: { api_key: "not a reference!", note: suspect } }] }, { composed: composeFixtures() });
    expect(codes(result).filter((code) => code === "SECRET_VALUE_SUSPECTED")).toHaveLength(2);
    expect(JSON.stringify(result)).not.toContain(suspect);
    expect(validate({ schemaVersion: 2, estate: { name: "test" }, integrations: [{ id: "one", kind: "prometheus", title: "one", baseUrl: "https://example.invalid", card: { api_key: "secret.ref" } }] }, { composed: composeFixtures() }).classification).toBe(0);
  });

  it("returns stable ordering and covers every validation gate without throwing", () => {
    const document = { schemaVersion: 2, estate: { name: "test" }, hosts: [host("z"), host("z")], integrations: [{ id: "x", kind: "unknown", title: "x", baseUrl: "https://example.invalid" }] };
    expect(JSON.stringify(validate(document))).toBe(JSON.stringify(validate(document)));
    expect(validate(null)).toMatchObject({ classification: 2, toolError: { code: "INPUT_NOT_OBJECT" } });
    expect(validate([])).toMatchObject({ classification: 2, toolError: { code: "INPUT_NOT_OBJECT" } });
    expect(validate({ schemaVersion: "1" })).toMatchObject({ classification: 2, toolError: { code: "VERSION_UNREADABLE" } });
    expect(validate({ schemaVersion: 99 })).toMatchObject({ classification: 1, findings: [{ code: "VERSION_UNSUPPORTED" }] });
    const hostile = new Proxy({}, { get() { throw new Error("hostile input"); } });
    expect(() => validate(hostile)).not.toThrow();
    expect(validate(hostile)).toMatchObject({ classification: 2, toolError: { code: "INTERNAL" } });
    for (const garbage of [undefined, true, 1, "text", {}, { schemaVersion: 2 }, { schemaVersion: 2, estate: null }]) {
      expect(() => validate(garbage)).not.toThrow();
    }
  });
});
