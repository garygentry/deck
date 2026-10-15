/**
 * The snapshot module's public server entry: what other modules may use of its server half.
 * Import from this file only, and declare the dependency in package.json;
 * `apps/server/test/module-imports.test.ts` enforces both.
 */

export type { SnapshotContent } from "./content.js";
