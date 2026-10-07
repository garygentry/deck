import { describe, expect, it } from "vitest";
import { merge, validate } from "../src/index.js";
import type { JsonObject } from "../src/types.js";

const REF_CODES = ["REF_HOST_UNRESOLVED", "REF_SERVICE_UNRESOLVED"];

const codes = (result: ReturnType<typeof validate>) => result.findings.map((item) => item.code);

const base: JsonObject = {
  schemaVersion: 1,
  estate: { name: "atlas" },
  hosts: [{ name: "alpha", kind: "vm", purpose: "base host" }],
  services: [{ host: "alpha", name: "api", kind: "systemd", purpose: "base service" }],
};

describe("overlay cross-references", () => {
  it("resolves overlay refs to base-only hosts/services without re-declaring them", () => {
    const overlay: JsonObject = {
      schemaVersion: 1,
      groups: [{
        id: "main",
        title: "Main",
        items: [
          { type: "service", host: "alpha", name: "api", title: "API" },
          { type: "group", id: "nested", title: "Nested", items: [{ type: "service", host: "alpha", name: "api" }] },
        ],
      }],
    };

    const perLayer = validate(overlay, { layer: "overlay", base });
    expect(codes(perLayer)).not.toEqual(expect.arrayContaining([expect.stringMatching(/^REF_/)]));
    expect(perLayer.classification).toBe(0);

    // With no base to resolve against, an overlay falls back to conservative
    // per-layer reference checking, so a base-only ref IS flagged — the lenient
    // resolution is only safe when a base (the danglingReferences backstop) is
    // supplied, which the load pipeline always does.
    const standalone = validate(overlay, { layer: "overlay" });
    expect(standalone.classification).toBe(1);
    expect(codes(standalone)).toContain("REF_SERVICE_UNRESOLVED");

    const merged = validate(merge(base, overlay), { layer: "merged" });
    expect(merged.classification).toBe(0);
    for (const code of REF_CODES) expect(codes(merged)).not.toContain(code);
  });

  it("still fails a reference declared in no layer", () => {
    const overlay: JsonObject = {
      schemaVersion: 1,
      groups: [{
        id: "main",
        title: "Main",
        items: [{ type: "service", host: "ghost", name: "api" }],
      }],
    };

    const perLayer = validate(overlay, { layer: "overlay", base });
    expect(perLayer.classification).toBe(1);
    expect(perLayer.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "OVERLAY_DANGLING_REF", path: "/groups/0/items/0" }),
    ]));

    const merged = validate(merge(base, overlay), { layer: "merged" });
    expect(merged.classification).toBe(1);
    expect(merged.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "REF_SERVICE_UNRESOLVED", path: "/groups/0/items/0" }),
    ]));
  });

  it("keeps reference checking on base and merged layers", () => {
    const doc = { schemaVersion: 1, estate: { name: "atlas" }, services: [{ host: "ghost", name: "api", kind: "systemd", purpose: "x" }] };
    expect(codes(validate(doc, { layer: "base" }))).toContain("REF_HOST_UNRESOLVED");
    expect(codes(validate(doc))).toContain("REF_HOST_UNRESOLVED");
  });
});
