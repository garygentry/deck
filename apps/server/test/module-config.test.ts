import { ComposeError } from "@deck/schema";
import { defineServerModule, type ConfigRule } from "@deck/module-sdk";
import { afterEach, describe, expect, it } from "vitest";

import { load } from "../src/config/load.js";
import { planningRouteTable, RESERVED_ROOT_PATHS } from "../src/server/app.js";
import { builtinComposition, composeModules, moduleContribution } from "../src/modules/config.js";
import { ModuleManifestError } from "../src/modules/host.js";
import { dockerModule } from "../../../modules/docker/server/module.js";
import { prometheusModule } from "../../../modules/prometheus/server/module.js";
import { snapshotModule } from "../src/providers/snapshot/module.js";
import { portalModule } from "../../../modules/portal/server/module.js";
import { testHost, testModule } from "./util/modules.js";
import { makeConfigDir } from "./util/tmp-config.js";

interface Gadgets {
  items?: Array<{ id: string; size?: number }>;
}

const tooBig: ConfigRule<Gadgets> = (section) =>
  (section.items ?? []).flatMap((item, index) =>
    (item.size ?? 0) > 10 ? [{ code: "GADGETS_TOO_BIG", path: `/items/${index}/size`, message: `${item.id} is too big` }] : []);

/** A module that owns `modules.gadgets`, a finding code, a rule and a provider kind. */
const gadgets = defineServerModule<Gadgets>(
  {
    id: "gadgets",
    version: "1.0.0",
    deckApi: "^0.1",
    config: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: { items: { type: "array", items: { $ref: "#/$defs/Gadget" } } },
        $defs: {
          Gadget: {
            type: "object",
            additionalProperties: false,
            required: ["id"],
            properties: { id: { type: "string" }, size: { type: "integer" } },
          },
        },
      },
      ownership: { "": "overlay" },
      identity: { items: ["id"] },
      findings: [{ code: "GADGETS_TOO_BIG", severity: "warning", summary: "A gadget is too big.", fix: "Use a smaller gadget." }],
    },
    providerKinds: [{ kind: "gadget-feed", bindable: true }],
  },
  () => {},
  { configRules: [tooBig], kinds: { "gadget-feed": { binding: () => [] } } },
);

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function estate(layers: Record<string, unknown>): string {
  const made = makeConfigDir(layers);
  cleanups.push(made.cleanup);
  return made.dir;
}

/** No module sections and no environment: modules enabled unconditionally run. */
const NONE = { sectionOf: () => undefined, env: {} };

const base = { schemaVersion: 2, estate: { name: "gadget-lab" }, hosts: [{ name: "h", kind: "vm", purpose: "p" }] };

describe("module config composition", () => {
  it("maps a manifest's config, provider kinds and the module's rules to a contribution", () => {
    expect(moduleContribution(gadgets)).toMatchObject({
      id: "gadgets",
      ownership: { "": "overlay" },
      identity: { items: ["id"] },
      findings: [{ code: "GADGETS_TOO_BIG" }],
      providerKinds: [{ kind: "gadget-feed" }],
      rules: [tooBig],
    });
    expect(moduleContribution(testModule({ id: "bare" }))).toEqual({ id: "bare" });
  });

  it("validates a module's section, runs its rules, and knows its provider kinds when deck loads config", () => {
    const { composed } = composeModules([gadgets], NONE);
    const dir = estate({
      "00-base.yaml": { ...base, hosts: [{ name: "h", kind: "vm", purpose: "p" }] },
      "10-overlay.yaml": { schemaVersion: 2, hosts: [{ name: "h", bindings: { "gadget-feed": {} } }], modules: { gadgets: { items: [{ id: "a", size: 3 }] } } },
    });
    expect(load({ arg: dir, composed })).toMatchObject({ exitClass: 0, findings: [] });
    // Without the module, its section and its kind are unknown.
    expect(new Set(load({ arg: dir }).findings.map((finding) => finding.code))).toEqual(new Set(["MODULE_UNKNOWN"]));
    const bound = estate({ "00-base.yaml": base, "10-overlay.yaml": { schemaVersion: 2, hosts: [{ name: "h", bindings: { "gadget-feed": {} } }] } });
    expect(load({ arg: bound, composed }).findings).toEqual([]);
    expect(new Set(load({ arg: bound }).findings.map((finding) => finding.code))).toEqual(new Set(["PROVIDER_KIND_UNKNOWN"]));

    const big = estate({ "00-base.yaml": base, "10-overlay.yaml": { schemaVersion: 2, modules: { gadgets: { items: [{ id: "a", size: 30 }] } } } });
    expect(load({ arg: big, composed }).findings).toContainEqual({
      code: "GADGETS_TOO_BIG",
      severity: "warning",
      path: "/modules/gadgets/items/0/size",
      message: "a is too big",
    });
    const wrong = estate({ "00-base.yaml": base, "10-overlay.yaml": { schemaVersion: 2, modules: { gadgets: { items: [{ size: 1 }] } } } });
    expect(load({ arg: wrong, composed }).findings).toContainEqual(
      expect.objectContaining({ code: "SCHEMA_REQUIRED_MISSING", path: "/modules/gadgets/items/0/id" }),
    );
  });

  it("makes a key collision between two modules a MODULE_MANIFEST_CONFLICT", () => {
    const sameCode = testModule({
      id: "twin",
      config: { schema: { type: "object" }, findings: [{ code: "GADGETS_TOO_BIG", severity: "error", summary: "s", fix: "f" }] },
    });
    const sameKind = testModule({ id: "feeds", providerKinds: [{ kind: "gadget-feed" }] });
    // A kind a built-in data-source module owns collides the same way.
    const moduleKind = testModule({ id: "docker-again", providerKinds: [{ kind: "docker" }] });
    const prometheusKind = testModule({ id: "prometheus-again", providerKinds: [{ kind: "prometheus" }] });
    const snapshotKind = testModule({ id: "snapshot-again", providerKinds: [{ kind: "snapshot" }] });
    for (const modules of [[gadgets, sameCode], [gadgets, sameKind], [dockerModule, moduleKind], [prometheusModule, prometheusKind], [snapshotModule, snapshotKind]]) {
      // Composition (ComposeError) or the host's own planning (ModuleManifestError, for a kind
      // two modules declare) refuses them; either way it is a boot-failing conflict.
      let caught: unknown;
      try {
        composeModules(modules, NONE);
      } catch (error) {
        caught = error;
      }
      expect(caught instanceof ComposeError || caught instanceof ModuleManifestError).toBe(true);
      expect((caught as { code: string }).code).toBe("MODULE_MANIFEST_CONFLICT");
    }
    // A built-in section belongs to its module: a second module claiming it is a conflict too.
    const builtinSection = testModule({ id: "portal", config: { schema: { type: "object" } } });
    expect(() => composeModules([portalModule, builtinSection], NONE)).toThrow(/MODULE_MANIFEST_CONFLICT|duplicate module id/);
    try {
      composeModules([portalModule, builtinSection], NONE);
    } catch (error) {
      expect((error as { code?: string }).code).toBe("MODULE_MANIFEST_CONFLICT");
    }
  });

  it("composes a contribution that is unusable on its own as disabled, for the host to disable", () => {
    const broken = testModule({ id: "broken", config: { schema: { type: "object", notAKeyword: 1 } } });
    const { composed, invalid } = composeModules([gadgets, broken], NONE);
    expect([...invalid.keys()]).toEqual(["broken"]);
    expect(invalid.get("broken")).toContain("does not compile");
    expect(composed.moduleIds).toContain("gadgets");
    expect(composed.moduleIds).not.toContain("broken");
    expect(composed.knownModuleIds).toContain("broken");

    const { host } = testHost([gadgets, broken], { manifestProblems: invalid });
    expect(host.plan.filter((entry) => entry.enabled).map((entry) => entry.id)).toEqual(["gadgets"]);
    expect(host.findings).toEqual([
      expect.objectContaining({ code: "MODULE_MANIFEST_INVALID", severity: "warning", path: "/modules/broken" }),
    ]);
  });

  it("memoises the built-in composition per plan outcome", () => {
    expect(builtinComposition(NONE).composed).toBe(builtinComposition(NONE).composed);
    expect(builtinComposition(NONE).invalid.size).toBe(0);
  });
});

describe("module config follows the host's enabled set (review round 1)", () => {
  const broken = testModule({ id: "broken", config: { schema: { type: "object", notAKeyword: 1 } } });
  const gated = defineServerModule<Gadgets>(
    { ...gadgets.manifest, id: "gated", enabledBy: { env: "DECK_GATED_ENABLED" }, providerKinds: [], config: { ...gadgets.manifest.config!, findings: [{ code: "GATED_TOO_BIG", severity: "error", summary: "s", fix: "f" }] } },
    () => {},
    { configRules: [(section) => (section.items ?? []).some((item) => (item.size ?? 0) > 10) ? [{ code: "GATED_TOO_BIG", path: "/items", message: "too big" }] : []] },
  );

  it("an installed-but-broken module's section is an info finding naming the problem, not MODULE_UNKNOWN or an abort (L6)", () => {
    const dir = estate({ "00-base.yaml": base, "10-overlay.yaml": { schemaVersion: 2, modules: { broken: { anything: true } } } });
    const result = load({ arg: dir, modules: [broken], env: {} });
    expect(result).toMatchObject({ exitClass: 0 });
    expect(result.findings).toEqual([
      expect.objectContaining({
        code: "MODULE_SECTION_DISABLED",
        severity: "info",
        path: "/modules/broken",
        message: expect.stringContaining("config contribution is unusable"),
      }),
    ]);
    if (result.exitClass === 0) expect(result.moduleProblems.get("broken")).toContain("does not compile");
  });

  it("a known-but-disabled module's section gets no strict schema and no rules; enabling it checks both (L7)", () => {
    const dir = estate({ "00-base.yaml": base, "10-overlay.yaml": { schemaVersion: 2, modules: { gated: { items: [{ id: "a", size: 30 }], stray: 1 } } } });
    const off = load({ arg: dir, modules: [gated], env: {} });
    // Off: nothing fails, but the ruling (N4) still reports what enabling it would raise, at info.
    expect(off.exitClass).toBe(0);
    expect(off.findings.every(({ code, severity }) => code === "MODULE_SECTION_DISABLED" && severity === "info")).toBe(true);
    expect(off.findings[0]!.message).toContain("DECK_GATED_ENABLED");
    expect(off.findings.slice(1).map(({ message }) => message)).toEqual([
      expect.stringMatching(/^would fail when "gated" is enabled: SCHEMA_UNKNOWN_PROPERTY /),
    ]);
    const on = load({ arg: dir, modules: [gated], env: { DECK_GATED_ENABLED: "true" } });
    expect(on.exitClass).toBe(1);
    expect(on.findings.map(({ code }) => code)).toEqual(["SCHEMA_UNKNOWN_PROPERTY", "SCHEMA_UNKNOWN_PROPERTY"]);
    const clean = estate({ "00-base.yaml": base, "10-overlay.yaml": { schemaVersion: 2, modules: { gated: { items: [{ id: "a", size: 30 }] } } } });
    // The rule sees each layer it is given (here the overlay and the merged document).
    expect(new Set(load({ arg: clean, modules: [gated], env: { DECK_GATED_ENABLED: "true" } }).findings.map(({ code }) => code))).toEqual(new Set(["GATED_TOO_BIG"]));
  });

  it("a module whose config rule throws is reported and set aside, not a failed load (L8)", () => {
    const throwing = defineServerModule({ ...gadgets.manifest, id: "throwing", providerKinds: [], config: { schema: { type: "object" } } }, () => {}, {
      configRules: [() => { throw new Error("rule bug"); }],
    });
    const dir = estate({ "00-base.yaml": base, "10-overlay.yaml": { schemaVersion: 2, modules: { throwing: {} } } });
    const result = load({ arg: dir, modules: [throwing], env: {} });
    expect(result.exitClass).toBe(0);
    expect(result.findings).toContainEqual(expect.objectContaining({ code: "MODULE_RULE_FAILED", severity: "info", path: "/modules/throwing" }));
    if (result.exitClass !== 0) return;
    expect(result.moduleProblems.get("throwing")).toContain("rule bug");
    // Boot hands the problem to the host, which disables the module before init.
    const { host } = testHost([throwing], { manifestProblems: result.moduleProblems });
    expect(host.plan).toEqual([expect.objectContaining({ id: "throwing", enabled: false })]);
    expect(host.findings).toEqual([expect.objectContaining({ code: "MODULE_MANIFEST_INVALID", message: expect.stringContaining("rule bug") })]);
  });

  it("an overlay may leave out a module's base-owned required fields, through the loader (C1)", () => {
    const racks = defineServerModule({
      id: "racks",
      version: "1.0.0",
      deckApi: "^0.1",
      config: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: { items: { type: "array", items: { $ref: "#/$defs/Rack" } } },
          $defs: {
            Rack: {
              type: "object",
              additionalProperties: false,
              required: ["id", "name"],
              properties: { id: { type: "string" }, name: { type: "string" }, label: { type: "string" } },
            },
          },
        },
        ownership: { "": "container", items: "container", "items[].id": "base", "items[].name": "base", "items[].label": "overlay" },
        identity: { items: ["id"] },
      },
    }, () => {});
    const dir = estate({
      "00-base.yaml": { ...base, modules: { racks: { items: [{ id: "a", name: "Rack A" }] } } },
      "10-overlay.yaml": { schemaVersion: 2, modules: { racks: { items: [{ id: "a", label: "Shown" }] } } },
    });
    const result = load({ arg: dir, modules: [racks], env: {} });
    expect(result).toMatchObject({ exitClass: 0, findings: [] });
    if (result.exitClass === 0) {
      expect((result.config as unknown as { modules: { racks: unknown } }).modules.racks).toEqual({ items: [{ id: "a", name: "Rack A", label: "Shown" }] });
    }
  });

  it("duplicate identities in a module array fail the load instead of merging away (C2)", () => {
    const dir = estate({ "00-base.yaml": base, "10-overlay.yaml": { schemaVersion: 2, modules: { gadgets: { items: [{ id: "a", size: 1 }, { id: "a", size: 2 }] } } } });
    const result = load({ arg: dir, modules: [gadgets], env: {} });
    expect(result.exitClass).toBe(1);
    expect(result.findings).toContainEqual(expect.objectContaining({ code: "ID_DUPLICATE", path: "/modules/gadgets/items/1" }));
  });
});

describe("module host: a section for a module that is not enabled", () => {
  it("reports MODULE_SECTION_DISABLED for an env-gated module whose section is present", () => {
    const gated = testModule({ id: "gated", enabledBy: { env: "DECK_GATED_ENABLED" } });
    const { host, lines } = testHost([gated], { sectionOf: (id) => (id === "gated" ? {} : undefined) });
    expect(host.findings).toEqual([
      {
        code: "MODULE_SECTION_DISABLED",
        severity: "info",
        path: "/modules/gated",
        message: expect.stringContaining("DECK_GATED_ENABLED"),
      },
    ]);
    expect(lines).toContainEqual(expect.objectContaining({ event: "module.disabled", module: "gated", code: "MODULE_SECTION_DISABLED" }));
  });

  it("stays quiet without a section, or when the module is enabled", () => {
    const gated = testModule({ id: "gated", enabledBy: { env: "DECK_GATED_ENABLED" } });
    expect(testHost([gated]).host.findings).toEqual([]);
    const enabled = testHost([gated], { sectionOf: () => ({}), env: { DECK_GATED_ENABLED: "true" } });
    expect(enabled.host.findings).toEqual([]);
  });
});

describe("module config: review round 2", () => {
  it("a v2 estate repeating a portal service and a link in one group loads clean, as in v1 (N1)", () => {
    expect(load({ arg: "test/fixtures/portal-repeated-items", env: {} })).toMatchObject({ exitClass: 0, findings: [] });
  });

  const inventory = defineServerModule<{ n?: number }>(
    {
      id: "inv",
      version: "1.0.0",
      deckApi: "^0.1",
      enabledBy: { env: "INV_ON" },
      config: {
        schema: { type: "object", additionalProperties: false, properties: { n: { type: "integer" } } },
        ownership: { "": "base" },
        findings: [{ code: "INV_TOO_BIG", severity: "error", summary: "s", fix: "f" }],
      },
    },
    () => {},
    { configRules: [(section) => ((section.n ?? 0) > 10 ? [{ code: "INV_TOO_BIG", path: "/n", message: "n is too big" }] : [])] },
  );

  it("switching off a module with a base-owned section does not fail the load (N2)", () => {
    const dir = estate({ "00-base.yaml": { ...base, modules: { inv: { n: 1 } } }, "10-overlay.yaml": { schemaVersion: 2 } });
    expect(load({ arg: dir, modules: [inventory], env: { INV_ON: "true" } })).toMatchObject({ exitClass: 0, findings: [] });
    const off = load({ arg: dir, modules: [inventory], env: {} });
    expect(off.exitClass).toBe(0);
    expect(off.findings.map(({ code, severity }) => [code, severity])).toEqual([["MODULE_SECTION_DISABLED", "info"]]);
  });

  it("deck validate still checks a disabled section, reporting what would fail at info and exiting 0 (N4)", () => {
    const dir = estate({ "00-base.yaml": { ...base, modules: { inv: { n: 11, extra: true } } } });
    const off = load({ arg: dir, modules: [inventory], env: {} });
    expect(off.exitClass).toBe(0);
    expect(off.findings.map(({ path, message }) => [path, message])).toEqual([
      ["/modules/inv", expect.stringContaining("not enabled (not enabled: INV_ON is not true)")],
      ["/modules/inv/extra", expect.stringMatching(/^would fail when "inv" is enabled: SCHEMA_UNKNOWN_PROPERTY/)],
    ]);
    const shapeOk = estate({ "00-base.yaml": { ...base, modules: { inv: { n: 11 } } } });
    expect(load({ arg: shapeOk, modules: [inventory], env: {} }).findings.map(({ message }) => message))
      .toContain('would fail when "inv" is enabled: INV_TOO_BIG n is too big');
    // The same section fails once the module is on.
    expect(load({ arg: shapeOk, modules: [inventory], env: { INV_ON: "true" } }).exitClass).toBe(1);
  });

  it("a module whose route collides with the kernel is off at load as at boot, so its error rule cannot fail boot (N5)", () => {
    const colliding = defineServerModule<{ n?: number }>(
      {
        id: "clash",
        version: "1.0.0",
        deckApi: "^0.1",
        config: { schema: { type: "object" }, findings: [{ code: "CLASH_BAD", severity: "error", summary: "s", fix: "f" }] },
        contributes: { routes: { legacyAliases: ["/api/config"] } },
      },
      () => {},
      { configRules: [() => [{ code: "CLASH_BAD", path: "", message: "always" }]] },
    );
    const dir = estate({ "00-base.yaml": base, "10-overlay.yaml": { schemaVersion: 2, modules: { clash: {} } } });
    const result = load({ arg: dir, modules: [colliding], env: {} });
    expect(result.exitClass).toBe(0);
    expect(result.findings.every(({ severity }) => severity === "info")).toBe(true);
    expect(result.findings[0]).toMatchObject({ code: "MODULE_SECTION_DISABLED", message: expect.stringContaining("collides with kernel route") });
    // Boot's host plan, with the same table, disables it too.
    const { host } = testHost([colliding], { kernelRoutes: planningRouteTable(), reservedRootPaths: RESERVED_ROOT_PATHS });
    expect(host.plan).toEqual([expect.objectContaining({ id: "clash", enabled: false })]);
  });
});

describe("module config: C2.7 review round 1", () => {
  it("strict validation catches a duplicate a later overlay's merge would hide, whether the module is on or off (C1)", () => {
    const nodes = defineServerModule(
      {
        id: "nodes",
        version: "1.0.0",
        deckApi: "^0.1",
        enabledBy: { env: "NODES_ON" },
        config: {
          schema: { type: "object", additionalProperties: false, properties: { nodes: { type: "array", items: { type: "object", properties: { id: { type: "string" } } } } } },
          identity: { nodes: ["id"] },
          unique: [{ paths: ["nodes[]"], key: ["id"] }],
        },
      },
      () => {},
    );
    const dir = estate({
      "00-base.yaml": { schemaVersion: 2, estate: { name: "c1" } },
      "10-overlay.yaml": { schemaVersion: 2, modules: { nodes: { nodes: [{ id: "x" }] } } },
      "20-overlay.yaml": { schemaVersion: 2, modules: { nodes: { nodes: [{ id: "x" }, { id: "x" }] } } },
    });
    const duplicate = expect.objectContaining({ code: "ID_DUPLICATE", severity: "error", path: "/modules/nodes/nodes/1" });
    for (const env of [{ NODES_ON: "1" }, {}]) {
      const result = load({ arg: dir, env, modules: [nodes], disabledSections: "strict" });
      expect(result.exitClass, JSON.stringify(env)).toBe(1);
      expect(result.findings).toContainEqual(duplicate);
    }
    // Boot (advisory) is never blocked by a switched-off module.
    expect(load({ arg: dir, env: {}, modules: [nodes] }).exitClass).toBe(0);
  });
});
