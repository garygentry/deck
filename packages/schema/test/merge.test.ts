import { describe, expect, it } from "vitest";
import { merge, MergeError } from "../src/merge.js";
import type { JsonObject } from "../src/types.js";
import { deepFreeze } from "./util.js";

const base: JsonObject = {
  schemaVersion: 1,
  estate: { name: "atlas", timezone: "UTC" },
  hosts: [
    { name: "beta", kind: "vm", purpose: "base beta" },
    { name: "alpha", kind: "bare-metal", purpose: "base alpha" },
  ],
  services: [{ host: "alpha", name: "api", kind: "systemd", purpose: "base api" }],
  groups: [{ id: "main", title: "Base", items: [{ type: "service", host: "alpha", name: "api" }] }],
};

const overlay: JsonObject = {
  schemaVersion: 1,
  estate: { name: "ignored", freshness: { snapshotStaleAfter: "PT6H" } },
  hosts: [
    { name: "alpha", purpose: "ignored", hidden: true },
    { name: "gamma", hidden: true },
    { name: "delta", hidden: false },
  ],
  services: [{ host: "alpha", name: "api", links: [{ title: "Docs", href: "https://example.test/api" }] }],
  groups: [{ id: "main", title: "Overlay", items: [{ type: "service", host: "alpha", name: "api", title: "API" }] }],
};

describe("merge", () => {
  it("pairs identities, applies ownership, appends in overlay order, and never deletes", () => {
    const result = merge(base, overlay);
    expect(result.estate).toEqual({ name: "atlas", timezone: "UTC", freshness: { snapshotStaleAfter: "PT6H" } });
    expect(result.hosts).toEqual([
      { name: "beta", kind: "vm", purpose: "base beta" },
      { name: "alpha", kind: "bare-metal", purpose: "base alpha", hidden: true },
      { name: "gamma", hidden: true },
      { name: "delta", hidden: false },
    ]);
    expect((result.services as JsonObject[])[0].links).toEqual([
      { title: "Docs", href: "https://example.test/api" },
    ]);
    expect((result.groups as JsonObject[])[0]).toMatchObject({
      id: "main", title: "Overlay", items: [{ type: "service", host: "alpha", name: "api", title: "API" }],
    });
  });

  it("is deterministic under repeated calls and a shared-key overlay shuffle", () => {
    const expected = JSON.stringify(merge(base, overlay));
    expect([merge(base, overlay), merge(base, overlay), merge(base, overlay)].map((value) => JSON.stringify(value)))
      .toEqual([expected, expected, expected]);
    const shuffled: JsonObject = {
      groups: overlay.groups,
      services: overlay.services,
      hosts: overlay.hosts,
      estate: overlay.estate,
      schemaVersion: overlay.schemaVersion,
    };
    expect(JSON.stringify(merge(base, shuffled))).toBe(expected);
  });

  it("constructs fresh output without changing frozen inputs", () => {
    const frozenBase = deepFreeze(structuredClone(base));
    const frozenOverlay = deepFreeze(structuredClone(overlay));
    const result = merge(frozenBase, frozenOverlay);
    expect(result).toEqual(merge(base, overlay));
    expect(result).not.toBe(frozenBase);
    expect(result.estate).not.toBe(frozenBase.estate);
  });

  it("reports each precondition with its layer and JSON Pointer", () => {
    expectMergeError(() => merge([] as unknown as JsonObject, overlay), "MERGE_INPUT_NOT_OBJECT", "base", "");
    expectMergeError(() => merge(base, { estate: {} }), "MERGE_VERSION_MISMATCH", "overlay", "/schemaVersion");
    expectMergeError(
      () => merge(base, { schemaVersion: 1, hosts: [{ hidden: true }] }),
      "MERGE_IDENTITY_MISSING", "overlay", "/hosts/0",
    );
  });

  it("skips prototype-pollution keys at every copied depth", () => {
    const unsafe = JSON.parse(
      '{"schemaVersion":1,"estate":{"name":"atlas","__proto__":{"polluted":true},"constructor":1,"prototype":2}}',
    ) as JsonObject;
    const result = merge(unsafe, { schemaVersion: 1, estate: {} });
    const estate = result.estate as JsonObject;
    expect(Object.keys(estate)).toEqual(["name"]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

function expectMergeError(
  action: () => unknown,
  code: MergeError["code"],
  layer: MergeError["layer"],
  path: string,
): void {
  try {
    action();
    throw new Error("expected merge to throw");
  } catch (error) {
    expect(error).toBeInstanceOf(MergeError);
    expect(error).toMatchObject({ code, layer, path });
  }
}
