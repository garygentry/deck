import { describe, expect, it } from "vitest";

import {
  assertJsonSerialisable,
  DECK_API_VERSION,
  defineServerModule,
  isDeckApiRange,
  jsonSnapshot,
  ManifestSerialisationError,
  MODULE_ID_PATTERN,
  resolvePointer,
  satisfiesDeckApi,
} from "../src/index.js";
import { pilotManifest } from "./pilot-manifest.js";

describe("manifest serialisation", () => {
  it("round-trips the pilot manifest through JSON unchanged", () => {
    expect(JSON.parse(JSON.stringify(pilotManifest))).toEqual(pilotManifest);
    expect(() => assertJsonSerialisable(pilotManifest)).not.toThrow();
  });

  it.each([
    ["a function", { config: { schema: { default: () => 1 } } }, "/config/schema/default"],
    ["undefined", { dependsOn: undefined }, "/dependsOn"],
    ["NaN", { version: Number.NaN }, "/version"],
    ["a class instance", { at: new Date(0) }, "/at"],
    ["a bigint", { n: 1n }, "/n"],
  ])("rejects %s with its pointer", (_label, value, path) => {
    expect(() => assertJsonSerialisable(value)).toThrow(ManifestSerialisationError);
    expect(() => assertJsonSerialisable(value)).toThrow(`manifest${path}:`);
  });

  it("rejects cycles but allows shared, acyclic references", () => {
    const shared = { a: 1 };
    expect(() => assertJsonSerialisable({ x: shared, y: shared })).not.toThrow();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => assertJsonSerialisable(cyclic)).toThrow("cycle");
  });

  it("rejects an accessor without calling it (C8)", () => {
    let calls = 0;
    const manifest = {
      id: "x",
      get env() {
        calls += 1;
        return calls === 1 ? [] : ["DECK_SECRET"];
      },
    };
    expect(() => assertJsonSerialisable(manifest)).toThrow("manifest/env: accessor properties are not JSON");
    expect(calls).toBe(0);
    const setterOnly = Object.defineProperty({}, "x", { set() {}, enumerable: true });
    expect(() => assertJsonSerialisable(setterOnly)).toThrow("accessor");
  });

  it("rejects symbol keys, non-enumerable properties and sparse arrays", () => {
    expect(() => assertJsonSerialisable({ [Symbol("s")]: 1 })).toThrow("symbol keys");
    expect(() => assertJsonSerialisable(Object.defineProperty({}, "hidden", { value: 1 }))).toThrow("manifest/hidden: non-enumerable");
    // eslint-disable-next-line no-sparse-arrays
    expect(() => assertJsonSerialisable({ list: [1, , 3] })).toThrow("manifest/list/1: sparse");
  });

  it("snapshots a validated value into a frozen copy sharing nothing with the source", () => {
    const source = { id: "x", env: ["A"], nested: { deep: [{ k: 1 }] } };
    const snapshot = jsonSnapshot(source);
    expect(snapshot).toEqual(source);
    source.env.push("B");
    source.nested.deep[0]!.k = 2;
    expect(snapshot).toEqual({ id: "x", env: ["A"], nested: { deep: [{ k: 1 }] } });
    expect(Object.isFrozen(snapshot.nested.deep[0])).toBe(true);
    expect(() => jsonSnapshot({ get x() { return 1; } })).toThrow(ManifestSerialisationError);
  });

  it("freezes the server module and keeps the manifest as data", () => {
    const module = defineServerModule(pilotManifest, () => {});
    expect(Object.isFrozen(module)).toBe(true);
    expect(module.manifest).toBe(pilotManifest);
    expect("configRules" in module).toBe(false);
  });

  it("carries config rules beside the manifest, not in it", () => {
    const rule = () => [];
    const module = defineServerModule(pilotManifest, () => {}, { configRules: [rule] });
    expect(module.configRules).toEqual([rule]);
    expect(module.manifest).not.toHaveProperty("configRules");
  });

  it("carries provider-kind handlers beside the manifest, not in it", () => {
    const kinds = { feed: { binding: () => [] } };
    const module = defineServerModule({ ...pilotManifest, providerKinds: [{ kind: "feed", bindable: true }] }, () => {}, { kinds });
    expect(module.kinds).toBe(kinds);
    expect(module.manifest).not.toHaveProperty("kinds");
    expect("kinds" in defineServerModule(pilotManifest, () => {})).toBe(false);
    // The manifest, flags included, stays JSON.
    expect(JSON.parse(JSON.stringify(module.manifest)).providerKinds).toEqual([{ kind: "feed", bindable: true }]);
  });
});

describe("resolvePointer", () => {
  const doc = { claude: { statusLine: { credentialEnv: "TOKEN" } }, "a/b": { "~c": 1 } };
  it("follows RFC 6901 pointers, including escapes", () => {
    expect(resolvePointer(doc, "/claude/statusLine/credentialEnv")).toBe("TOKEN");
    expect(resolvePointer(doc, "/a~1b/~0c")).toBe(1);
    expect(resolvePointer(doc, "")).toBe(doc);
  });
  it("returns undefined for a missing step", () => {
    expect(resolvePointer(doc, "/claude/missing/x")).toBeUndefined();
    expect(resolvePointer(undefined, "/a")).toBeUndefined();
    expect(resolvePointer(doc, "/claude/statusLine/credentialEnv/length")).toBeUndefined();
  });
});

describe("deckApi", () => {
  it("starts at 0.x", () => {
    expect(DECK_API_VERSION).toMatch(/^0\.\d+\.\d+$/);
    expect(satisfiesDeckApi(pilotManifest.deckApi)).toBe(true);
  });

  it.each([
    ["^0.1", "0.1.0", true],
    ["^0.1", "0.1.9", true],
    ["^0.1", "0.2.0", false],
    ["^0.1.3", "0.1.2", false],
    ["^0", "0.7.1", true],
    ["^0", "1.0.0", false],
    ["^0.0.1", "0.0.1", true],
    ["^0.0.1", "0.0.2", false],
    ["^0.0", "0.0.7", true],
    ["^0.0", "0.1.0", false],
    ["^1", "1.4.0", true],
    ["^1.2", "1.1.0", false],
    ["^1.2", "2.0.0", false],
    ["0.1.0", "0.1.0", true],
    ["0.1.0", "0.1.1", false],
    ["0.1", "0.1.0", false],
    [">=0.1", "0.1.0", false],
  ])("%s against %s → %s", (range, version, expected) => {
    expect(satisfiesDeckApi(range, version)).toBe(expected);
  });

  it("recognises supported ranges only", () => {
    expect(isDeckApiRange("^0.1")).toBe(true);
    expect(isDeckApiRange("1.2.3")).toBe(true);
    expect(isDeckApiRange("1.2")).toBe(false);
    expect(isDeckApiRange("~1.2")).toBe(false);
  });
});

describe("module ids", () => {
  it.each(["llm-usage", "core", "a1-b2"])("accepts %s", (id) => expect(MODULE_ID_PATTERN.test(id)).toBe(true));
  it.each(["LLM", "-x", "x-", "a--b", "a_b", ""])("rejects %j", (id) => expect(MODULE_ID_PATTERN.test(id)).toBe(false));
});
