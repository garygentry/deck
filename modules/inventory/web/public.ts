/**
 * The inventory module's public web entry: what other modules may use of its web half. Import
 * from this file only, and declare the dependency in package.json;
 * `apps/server/test/module-imports.test.ts` enforces both. Add `inventory` to the manifest's
 * `dependsOn` too when the importer cannot run without it, as drift does.
 *
 * The drift module reads the snapshot through inventory's store (one network writer, shared
 * generations) and resolves entity links through inventory's model. The shared web test
 * harness (`apps/web/test/inventory-harness.ts`) builds committed generations with the real
 * model builder and its state types.
 */

export { getInventoryGeneration, subscribeInventoryGeneration } from "./inventory-store.js";
export type { InventoryData, InventoryGeneration, SnapshotClientState } from "./inventory-store.js";
export { buildInventoryModel, findHost, findService, hostHref, serviceHref } from "./model.js";
export type { InventoryModel } from "./model.js";
