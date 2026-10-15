import { describe, expect, it } from "vitest";

import { BUILTIN_MODULES } from "../src/modules/builtin.js";
import { planModules } from "../src/modules/host.js";

const plan = (modules = BUILTIN_MODULES) =>
  planModules({ modules, sectionOf: () => undefined, env: {}, builtins: new Set(BUILTIN_MODULES) });

describe("built-in dependsOn", () => {
  it.each([
    ["inventory", ["snapshot"]],
    ["drift", ["snapshot", "inventory"]],
  ])("%s depends on %j and is planned after each", (id, deps) => {
    const manifest = BUILTIN_MODULES.find((module) => module.manifest.id === id)!.manifest;
    expect(manifest.dependsOn).toEqual(deps);
    const order = plan().plan.filter((entry) => entry.enabled).map((entry) => entry.id);
    for (const dep of deps) {
      expect(order.indexOf(dep)).toBeGreaterThanOrEqual(0);
      expect(order.indexOf(id)).toBeGreaterThan(order.indexOf(dep));
    }
  });

  it("disables drift, and nothing else, when inventory is unavailable", () => {
    // Drift's web half reads the snapshot through inventory's store and model.
    const planning = plan(BUILTIN_MODULES.filter((module) => module.manifest.id !== "inventory"));
    const missing = planning.findings.filter((finding) => finding.code === "MODULE_DEPENDENCY_MISSING");
    expect(missing.map((finding) => [finding.path, finding.message])).toEqual([
      ["/modules/drift", 'Module "drift" depends on "inventory", which is not available.'],
    ]);
    const off = planning.plan.filter((entry) => !entry.enabled).map((entry) => entry.id);
    expect(off).toContain("drift");
    expect(planning.plan.find((entry) => entry.id === "snapshot")?.enabled).toBe(true);
    expect(planning.plan.find((entry) => entry.id === "portal")?.enabled).toBe(true);
    // Whatever else is off is off without inventory too: only drift follows it.
    const baseline = plan().plan.filter((entry) => !entry.enabled).map((entry) => entry.id);
    expect(off.filter((id) => id !== "drift").sort()).toEqual(baseline.sort());
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

  it("is declared only on snapshot and inventory by built-ins (optional consumers do not depend)", () => {
    const declared = BUILTIN_MODULES.filter((module) => (module.manifest.dependsOn ?? []).length > 0)
      .map((module) => [module.manifest.id, module.manifest.dependsOn])
      .sort();
    expect(declared).toEqual([["drift", ["snapshot", "inventory"]], ["inventory", ["snapshot"]]]);
  });
});
