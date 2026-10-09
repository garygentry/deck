import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { ModuleManifest, WebModule } from "@deck/module-sdk";
import { describe, expect, it } from "vitest";

import { BUILTIN_MODULES } from "../../server/src/modules/builtin.js";
import { discoveredWebHalves } from "../src/registry/discover.js";

const MODULES_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../modules");

/** The kernel's own web module (the `core/*` widget vocabulary), which no server module owns. */
const KERNEL_WEB_MODULES = new Set(["core"]);

/** A manifest names a web component: a page, an extension or a widget type rendered by the web half. */
function hasWebHalf(manifest: ModuleManifest): boolean {
  const { pages = [], extensions = [], widgetTypes = [] } = manifest.contributes ?? {};
  return [...pages, ...extensions, ...widgetTypes].some((entry) => typeof (entry as { component?: unknown }).component === "string");
}

function isWebModule(value: unknown): value is WebModule {
  const manifest = (value as { manifest?: { id?: unknown } } | null)?.manifest;
  return typeof value === "object" && value !== null && typeof manifest?.id === "string" && typeof (value as { components?: unknown }).components === "object";
}

/** The module ids each discovered web half defines, by its path. */
const definedIds = Object.entries(discoveredWebHalves).map(([path, exports]) => ({
  path,
  ids: Object.values(exports).filter(isWebModule).map((module) => module.manifest.id),
}));

describe("web discovery", () => {
  it("finds exactly the web halves of the server's built-in modules", () => {
    const discovered = definedIds.flatMap(({ ids }) => ids).filter((id) => !KERNEL_WEB_MODULES.has(id));
    const expected = BUILTIN_MODULES.filter(({ manifest }) => hasWebHalf(manifest)).map(({ manifest }) => manifest.id);
    expect([...discovered].sort()).toEqual([...expected].sort());
  });

  it("discovers every modules/<id>/web, each defining the module of its own directory", () => {
    const dirs = readdirSync(MODULES_ROOT, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    const withWeb = dirs.filter((id) => existsSync(join(MODULES_ROOT, id, "web/index.ts"))).sort();
    const colocated = definedIds
      .map(({ path, ids }) => ({ dir: /\/modules\/([^/]+)\/web\/index\.ts$/.exec(path)?.[1], ids }))
      .filter((entry): entry is { dir: string; ids: string[] } => entry.dir !== undefined);
    expect(colocated.map(({ dir }) => dir).sort()).toEqual(withWeb);
    for (const { dir, ids } of colocated) expect(ids, `modules/${dir}/web/index.ts`).toEqual([dir]);
    // A module directory is a built-in the server loads from there, under its own id.
    const serverIds = new Set(BUILTIN_MODULES.map(({ manifest }) => manifest.id));
    const builtinList = readFileSync(resolve(MODULES_ROOT, "../apps/server/src/modules/builtin.ts"), "utf8");
    for (const id of dirs) {
      expect(serverIds.has(id), `modules/${id} is not in BUILTIN_MODULES`).toBe(true);
      expect(builtinList, `builtin.ts imports modules/${id}/server/module.js`).toContain(`/modules/${id}/server/module.js"`);
    }
  });
});
