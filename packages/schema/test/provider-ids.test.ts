import { describe, expect, it } from "vitest";

import { estateBindings, estateProviderIds, validate } from "../src/index.js";

const host = (name: string, bindings?: Record<string, unknown>) => ({
  name,
  kind: "vm",
  purpose: "test host",
  ...(bindings === undefined ? {} : { bindings }),
});

const service = (hostName: string, name: string, bindings?: Record<string, unknown>) => ({
  host: hostName,
  name,
  kind: "systemd",
  purpose: "test service",
  ...(bindings === undefined ? {} : { bindings }),
});

const integration = (id: string) => ({ id, kind: "prometheus", title: id, baseUrl: "https://prom.invalid" });
const source = (id: string) => ({ id, kind: "markdown-tree", title: id, location: { path: "/srv/notes" } });

const doc = (extra: Record<string, unknown>) => ({ schemaVersion: 2, estate: { name: "test" }, ...extra });

const idFindings = (document: unknown, layer?: "base" | "overlay" | "merged") =>
  validate(document, layer === undefined ? undefined : { layer })
    .findings.filter((finding) => finding.code === "ID_DUPLICATE" || finding.code === "PROVIDER_ID_SHARED")
    .map(({ code, path, severity, message }) => ({ code, path, severity, message }));
const duplicates = (document: unknown) => idFindings(document);

describe("estate provider ids", () => {
  it("derives a binding's id from its own id, else <kind>:<owner>, hosts before services", () => {
    const bindings = estateBindings({
      hosts: [host("alpha", { "http-health": { url: "https://a.invalid" }, docker: { id: "dock-a" }, link: "not an object" })] as never,
      services: [service("alpha", "api", { "http-health": { url: "https://b.invalid" } })] as never,
    });
    expect(bindings.map(({ kind, owner, id, path }) => ({ kind, owner, id, path }))).toEqual([
      { kind: "http-health", owner: "host:alpha", id: "http-health:host:alpha", path: "/hosts/0/bindings/http-health" },
      { kind: "docker", owner: "host:alpha", id: "dock-a", path: "/hosts/0/bindings/docker" },
      { kind: "http-health", owner: "service:alpha:api", id: "http-health:service:alpha:api", path: "/services/0/bindings/http-health" },
    ]);
  });

  it("lists integrations, then sources, then bindings", () => {
    const ids = estateProviderIds({
      integrations: [integration("prom")] as never,
      sources: [source("notes")] as never,
      hosts: [host("alpha", { "http-health": { id: "probe", url: "https://a.invalid" } })] as never,
    });
    expect(ids).toEqual([
      { id: "prom", path: "/integrations/0", collection: "integrations" },
      { id: "notes", path: "/sources/0", collection: "sources" },
      { id: "probe", path: "/hosts/0/bindings/http-health", collection: "bindings" },
    ]);
  });
});

describe("validate: a provider id shared across collections", () => {
  it("is a warning naming both paths (validation cannot tell which declarations register)", () => {
    expect(duplicates(doc({ integrations: [integration("shared")], sources: [source("shared")] }))).toEqual([
      {
        code: "PROVIDER_ID_SHARED",
        path: "/sources/0",
        severity: "warning",
        message: 'Provider id "shared" at /sources/0 is also used at /integrations/0.',
      },
    ]);
  });

  it("covers a binding id equal to an integration id, whatever the binding's kind", () => {
    const found = duplicates(doc({ integrations: [integration("shared")], hosts: [host("alpha", { docker: { id: "shared" } })] }));
    expect(found.map(({ code, path }) => [code, path])).toEqual([["PROVIDER_ID_SHARED", "/hosts/0/bindings/docker"]]);
  });

  it("covers two bindings with the same id, explicit or derived, once per repeat", () => {
    const found = duplicates(
      doc({
        hosts: [host("alpha", { "http-health": { url: "https://a.invalid" } }), host("beta", { "http-health": { id: "http-health:host:alpha", url: "https://b.invalid" } })],
        services: [service("alpha", "api", { "http-health": { id: "probe", url: "https://c.invalid" } }), service("beta", "api", { "http-health": { id: "probe", url: "https://d.invalid" } })],
      }),
    );
    expect(found.map(({ path, message }) => [path, message])).toEqual([
      ["/hosts/1/bindings/http-health", 'Provider id "http-health:host:alpha" at /hosts/1/bindings/http-health is also used at /hosts/0/bindings/http-health.'],
      ["/services/1/bindings/http-health", 'Provider id "probe" at /services/1/bindings/http-health is also used at /services/0/bindings/http-health.'],
    ]);
  });

  it("leaves a repeat within one collection to its ID_DUPLICATE error, reported once", () => {
    expect(duplicates(doc({ integrations: [integration("same"), integration("same")] }))).toEqual([
      { code: "ID_DUPLICATE", path: "/integrations/1", severity: "error", message: 'Id "same" is used more than once within integrations.' },
    ]);
  });

  it("judges only the merged document: a single layer may lack ids its bindings inherit", () => {
    const layer = doc({ hosts: [host("alpha", { "http-health": { url: "https://a.invalid" } }), host("beta", { "http-health": { id: "http-health:host:alpha", url: "https://b.invalid" } })] });
    expect(idFindings(layer, "base")).toEqual([]);
    expect(idFindings(layer, "merged").map(({ code }) => code)).toEqual(["PROVIDER_ID_SHARED"]);
  });

  it("accepts distinct ids across every collection", () => {
    const document = doc({
      integrations: [integration("prom")],
      sources: [source("notes")],
      hosts: [host("alpha", { "http-health": { url: "https://a.invalid" } })],
      services: [service("alpha", "api", { "http-health": { id: "api-probe", url: "https://b.invalid" } })],
    });
    expect(duplicates(document)).toEqual([]);
  });
});
