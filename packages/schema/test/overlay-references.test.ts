import { describe, expect, it } from "vitest";
import { BUILTIN_CONTRIBUTIONS, composeConfig, merge, validate } from "../src/index.js";
import type { JsonObject } from "../src/types.js";

const REF_CODES = ["REF_HOST_UNRESOLVED", "REF_SERVICE_UNRESOLVED"];

const codes = (result: ReturnType<typeof validate>) => result.findings.map((item) => item.code);

const base: JsonObject = {
  schemaVersion: 2,
  estate: { name: "atlas" },
  hosts: [{ name: "alpha", kind: "vm", purpose: "base host" }],
  services: [{ host: "alpha", name: "api", kind: "systemd", purpose: "base service" }],
};

/** A module whose overlay-owned cards name services, at two levels, reported at the card. */
const composed = composeConfig([...BUILTIN_CONTRIBUTIONS, {
  id: "boards",
  schema: {
    type: "object",
    properties: {
      cards: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            host: { type: "string" },
            name: { type: "string" },
            cards: { type: "array", items: { type: "object", properties: { host: { type: "string" }, name: { type: "string" } } } },
          },
        },
      },
    },
  },
  identity: { cards: ["id"] },
  references: [
    { path: "cards[]", service: "name", at: "element" },
    { path: "cards[].cards[]", service: "name", at: "element" },
  ],
}]);

describe("overlay cross-references", () => {
  it("resolves overlay refs to base-only hosts/services without re-declaring them", () => {
    const overlay: JsonObject = {
      schemaVersion: 2,
      modules: { boards: { cards: [
        { id: "api", host: "alpha", name: "api" },
        { id: "nested", cards: [{ host: "alpha", name: "api" }] },
      ] } },
    };

    const perLayer = validate(overlay, { layer: "overlay", base, composed });
    expect(codes(perLayer)).not.toEqual(expect.arrayContaining([expect.stringMatching(/^REF_/)]));
    expect(perLayer.classification).toBe(0);

    // With no base to resolve against, an overlay falls back to conservative
    // per-layer reference checking, so a base-only ref IS flagged — the lenient
    // resolution is only safe when a base (the danglingReferences backstop) is
    // supplied, which the load pipeline always does.
    const standalone = validate(overlay, { layer: "overlay", composed });
    expect(standalone.classification).toBe(1);
    expect(codes(standalone)).toContain("REF_SERVICE_UNRESOLVED");

    const merged = validate(merge(base, overlay, composed), { layer: "merged", composed });
    expect(merged.classification).toBe(0);
    for (const code of REF_CODES) expect(codes(merged)).not.toContain(code);
  });

  it("still fails a reference declared in no layer", () => {
    const overlay: JsonObject = { schemaVersion: 2, modules: { boards: { cards: [{ id: "ghost", host: "ghost", name: "api" }] } } };

    const perLayer = validate(overlay, { layer: "overlay", base, composed });
    expect(perLayer.classification).toBe(1);
    expect(perLayer.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "OVERLAY_DANGLING_REF", path: "/modules/boards/cards/0" }),
    ]));

    const merged = validate(merge(base, overlay, composed), { layer: "merged", composed });
    expect(merged.classification).toBe(1);
    expect(merged.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "REF_SERVICE_UNRESOLVED", path: "/modules/boards/cards/0" }),
    ]));
  });

  it("keeps reference checking on base and merged layers", () => {
    const doc = { schemaVersion: 2, estate: { name: "atlas" }, services: [{ host: "ghost", name: "api", kind: "systemd", purpose: "x" }] };
    expect(codes(validate(doc, { layer: "base" }))).toContain("REF_HOST_UNRESOLVED");
    expect(codes(validate(doc))).toContain("REF_HOST_UNRESOLVED");
  });
});
