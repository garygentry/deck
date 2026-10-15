/**
 * The sources module's public server entry: what other modules may use of its server half. The
 * source-kind modules (`markdown-tree`, `file-tree`) build on it: their module definition, the
 * shared source store, the tree manifest they serve and the failure normalization. Import from
 * this file only, and declare the dependency in package.json; `apps/server/test/module-imports.test.ts`
 * enforces both.
 */

export { normalizeSourceFailure } from "./errors.js";
export { defineSourceKindModule, sourceKindManifest, type SourceKindModuleOptions } from "./kind-module.js";
export type { SourceStore } from "./store.js";
export type { SourceManifest } from "./tree.js";
