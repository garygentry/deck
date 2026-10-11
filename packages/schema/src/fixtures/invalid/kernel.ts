import type { InvalidFixture, JsonObject } from "../../types.js";

/**
 * Kernel-collection variants of the catalog codes whose primary fixture sits in a server
 * module's section (`modules.portal`), which this library does not compose. Each raises its
 * code on kernel keys alone, at `path`, so the library still exercises every code itself.
 * They are not part of `invalid`, whose entries deck's parity goldens pin.
 */
export const kernelInvalid: readonly (InvalidFixture & { path: string })[] = [
  {
    name: "id-duplicate-integrations",
    expect: "ID_DUPLICATE",
    layer: "merged",
    path: "/integrations/1",
    document: config({ integrations: [integration("same"), integration("same")] }),
  },
  {
    name: "id-duplicate-sources",
    expect: "ID_DUPLICATE",
    layer: "merged",
    path: "/sources/1",
    document: config({ sources: [source("same"), source("same")] }),
  },
  {
    name: "ref-service-unresolved-source-owner",
    expect: "REF_SERVICE_UNRESOLVED",
    layer: "merged",
    path: "/sources/0/owner/service",
    document: config({ hosts: [host("echo")], sources: [source("notes", { host: "echo", service: "absent" })] }),
  },
  {
    name: "layer-overlay-key-in-base-host-hidden",
    expect: "LAYER_OVERLAY_KEY_IN_BASE",
    layer: "base",
    path: "/hosts/0/hidden",
    document: config({ hosts: [{ ...host("echo"), hidden: true }] }),
  },
  {
    name: "overlay-dangling-ref-host",
    expect: "OVERLAY_DANGLING_REF",
    layer: "overlay",
    path: "/hosts/0",
    base: config({ hosts: [host("echo")] }),
    document: { schemaVersion: 2, hosts: [{ name: "absent", hidden: true }] },
  },
  {
    name: "overlay-dangling-ref-source-owner",
    expect: "OVERLAY_DANGLING_REF",
    layer: "overlay",
    path: "/sources/0/owner/host",
    base: config({ hosts: [host("echo")] }),
    document: { schemaVersion: 2, sources: [source("notes", { host: "absent" })] },
  },
];

function config(extra: JsonObject = {}): JsonObject {
  return { schemaVersion: 2, estate: { name: "invalid-fixture" }, ...extra };
}
function host(name: string): JsonObject { return { name, kind: "vm", purpose: "Invalid fixture host" }; }
function integration(id: string): JsonObject { return { id, kind: "link", title: "Fixture link", baseUrl: "https://fixture.invalid" }; }
function source(id: string, owner?: JsonObject): JsonObject {
  return { id, kind: "markdown-tree", title: "Fixture notes", location: { path: "/srv/notes" }, ...(owner === undefined ? {} : { owner }) };
}
