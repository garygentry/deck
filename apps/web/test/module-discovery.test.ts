import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { ModuleManifest } from "@deck/module-sdk";
import { beforeAll, describe, expect, it } from "vitest";

import { BUILTIN_MODULES } from "../../server/src/modules/builtin.js";
import { REPO_ROOT } from "./support/source-roots.js";

const MODULES_ROOT = join(REPO_ROOT, "modules");

/**
 * Web registrations the kernel makes itself, which no server module owns: the `core/*` widget
 * vocabulary and its controls, and the dev-only `/_ui` workbench page.
 */
const KERNEL_WEB_MODULES = new Set(["core", "ui-workbench"]);

/** A manifest names a web component: a page, an extension or a widget type rendered by the web half. */
function hasWebHalf(manifest: ModuleManifest): boolean {
  const { pages = [], extensions = [], widgetTypes = [] } = manifest.contributes ?? {};
  return [...pages, ...extensions, ...widgetTypes].some((entry) => typeof (entry as { component?: unknown }).component === "string");
}

/** The module ids the registry recorded once discovery imported every web half. */
let recorded: Set<string>;

beforeAll(async () => {
  await import("../src/registry/discover.js");
  const registry = await import("../src/registry/registry.js");
  recorded = new Set(registry.getAllExtensions().map(({ module }) => module));
});

describe("web discovery", () => {
  it("registers exactly the web halves of the server's built-in modules", () => {
    const registered = [...recorded].filter((id) => !KERNEL_WEB_MODULES.has(id)).sort();
    const expected = BUILTIN_MODULES.filter(({ manifest }) => hasWebHalf(manifest)).map(({ manifest }) => manifest.id).sort();
    expect(registered).toEqual(expected);
  });

  it("registers every modules/<id>/web under its own id, as a built-in the server loads from there", () => {
    const dirs = readdirSync(MODULES_ROOT, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    expect(dirs).toContain("llm-usage");
    const serverIds = new Set(BUILTIN_MODULES.map(({ manifest }) => manifest.id));
    const builtinList = readFileSync(join(REPO_ROOT, "apps/server/src/modules/builtin.ts"), "utf8");
    for (const id of dirs) {
      expect(serverIds.has(id), `modules/${id} is not in BUILTIN_MODULES`).toBe(true);
      expect(builtinList, `builtin.ts imports modules/${id}/server/module.js`).toContain(`/modules/${id}/server/module.js"`);
      if (existsSync(join(MODULES_ROOT, id, "web/index.ts"))) expect(recorded.has(id), `modules/${id}/web registers module "${id}"`).toBe(true);
    }
  });
});
