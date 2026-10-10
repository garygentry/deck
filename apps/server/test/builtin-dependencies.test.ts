import { describe, expect, it } from "vitest";

import { BUILTIN_MODULES } from "../src/modules/builtin.js";
import { planModules } from "../src/modules/host.js";

const plan = (modules = BUILTIN_MODULES) =>
  planModules({ modules, sectionOf: () => undefined, env: {}, builtins: new Set(BUILTIN_MODULES) });

describe("built-in dependsOn", () => {
  it.each(["drift", "inventory"])("%s depends on snapshot and is planned after it", (id) => {
    const manifest = BUILTIN_MODULES.find((module) => module.manifest.id === id)!.manifest;
    expect(manifest.dependsOn).toEqual(["snapshot"]);
    const order = plan().plan.filter((entry) => entry.enabled).map((entry) => entry.id);
    expect(order.indexOf("snapshot")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf(id)).toBeGreaterThan(order.indexOf("snapshot"));
  });

  it("disables drift and inventory, and nothing else, when snapshot is unavailable", () => {
    const planning = plan(BUILTIN_MODULES.filter((module) => module.manifest.id !== "snapshot"));
    const missing = planning.findings.filter((finding) => finding.code === "MODULE_DEPENDENCY_MISSING");
    expect(missing.map((finding) => finding.path).sort()).toEqual(["/modules/drift", "/modules/inventory"]);
    expect(planning.plan.filter((entry) => !entry.enabled).map((entry) => entry.id).sort()).toEqual(
      expect.arrayContaining(["drift", "inventory"]),
    );
    expect(planning.plan.find((entry) => entry.id === "portal")?.enabled).toBe(true);
  });

  it("is declared only on snapshot by built-ins (optional consumers do not depend)", () => {
    const declared = BUILTIN_MODULES.filter((module) => (module.manifest.dependsOn ?? []).length > 0)
      .map((module) => [module.manifest.id, module.manifest.dependsOn])
      .sort();
    expect(declared).toEqual([["drift", ["snapshot"]], ["inventory", ["snapshot"]]]);
  });
});
