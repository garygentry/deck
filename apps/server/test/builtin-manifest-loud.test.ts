import { defineServerModule, type JsonSchema, type ModuleManifest } from "@deck/module-sdk";
import { describe, expect, it } from "vitest";

import { load } from "../src/config/load.js";
import { ModuleManifestError, planModules } from "../src/modules/host.js";
import { prometheusModule } from "../../../modules/prometheus/server/module.js";
import { makeConfigDir } from "./util/tmp-config.js";

/**
 * An instance schema Ajv's `strictRequired` refuses to compile: `then.required` names a
 * property `then` does not define.
 */
const UNCOMPILABLE: JsonSchema = {
  type: "object",
  properties: { id: { type: "string" }, kind: { const: "prometheus" } },
  if: { properties: { kind: { const: "prometheus" } } },
  then: { required: ["baseUrl"] },
};

const manifest = (id: string, extra: Partial<ModuleManifest> = {}): ModuleManifest => ({ id, version: "1.0.0", deckApi: "^0.1", ...extra });

describe("a built-in module whose manifest or config contribution is unusable fails loudly", () => {
  it("planning throws MODULE_MANIFEST_INVALID for a built-in, and refuses (disables) any other module", () => {
    const broken = manifest("broken", { providerKinds: [{ kind: "broken", fixedId: "broken", bindable: true, statusCapable: true, status: { provider: "fixed", up: [] } }] });
    const builtin = defineServerModule(broken, () => {});
    const other = defineServerModule({ ...broken }, () => {});
    expect(() => planModules({ modules: [builtin], sectionOf: () => undefined, env: {}, builtins: new Set([builtin]) })).toThrow(
      expect.objectContaining({ name: "ModuleManifestError", code: "MODULE_MANIFEST_INVALID", moduleId: "broken" }),
    );
    const planned = planModules({ modules: [other], sectionOf: () => undefined, env: {}, builtins: new Set() });
    expect(planned.findings).toContainEqual(expect.objectContaining({ code: "MODULE_MANIFEST_INVALID" }));
    expect(planned.plan.find((entry) => entry.id === "broken")?.enabled).toBe(false);
  });

  it("an instanceSchema that does not compile (Ajv strictRequired) fails config loading, so boot and `deck validate`", () => {
    const kinds = prometheusModule.manifest.providerKinds!;
    const original = kinds[0]!.instanceSchema;
    const dir = makeConfigDir({ "00-base.yaml": { schemaVersion: 2, estate: { name: "loud" } } });
    // The real built-in object: built-in status is by identity, so a copy would not be one.
    kinds[0]!.instanceSchema = UNCOMPILABLE;
    try {
      const result = load({ arg: dir.dir, env: {} });
      if (result.exitClass !== 2) throw new Error(`expected a tool error, got exit class ${result.exitClass}`);
      expect(result.toolError).toEqual(expect.objectContaining({ code: "MODULE_MANIFEST_INVALID" }));
      expect(result.toolError.message).toMatch(/module "prometheus": built-in module has an invalid manifest: config contribution is unusable/);
    } finally {
      kinds[0]!.instanceSchema = original;
      dir.cleanup();
    }
  });

  it.each(["invalid", "^999.0"])("a built-in whose deckApi is %s fails planning loudly; another module is refused (MODULE_API_INCOMPATIBLE)", (deckApi) => {
    const builtin = defineServerModule(manifest("old", { deckApi }), () => {});
    expect(() => planModules({ modules: [builtin], sectionOf: () => undefined, env: {}, builtins: new Set([builtin]) })).toThrow(
      expect.objectContaining({ code: "MODULE_MANIFEST_INVALID", moduleId: "old", message: expect.stringContaining(`deckApi ${deckApi} is not satisfied`) }),
    );
    // Off by its switch, too: a built-in's deckApi is checked whether or not it runs.
    const off = defineServerModule(manifest("old", { deckApi, enabledBy: { env: "OLD_ON" } }), () => {});
    expect(() => planModules({ modules: [off], sectionOf: () => undefined, env: {}, builtins: new Set([off]) })).toThrow(expect.objectContaining({ code: "MODULE_MANIFEST_INVALID" }));
    const external = defineServerModule(manifest("old", { deckApi }), () => {});
    const planned = planModules({ modules: [external], sectionOf: () => undefined, env: {}, builtins: new Set() });
    expect(planned.findings).toContainEqual(expect.objectContaining({ code: "MODULE_API_INCOMPATIBLE" }));
    expect(planned.plan.find((entry) => entry.id === "old")?.enabled).toBe(false);
  });

  it("is a ModuleManifestError, which boot reports and exits on", () => {
    expect(new ModuleManifestError("x", "y", "MODULE_MANIFEST_INVALID").code).toBe("MODULE_MANIFEST_INVALID");
    expect(new ModuleManifestError("x", "y").code).toBe("MODULE_MANIFEST_CONFLICT");
  });
});
