/**
 * The inventory module's public web entry: what other modules may use of its web half. Import
 * from this file only, never from inventory's other files, and declare the dependency (the
 * module's manifest `dependsOn` and its package.json); `apps/server/test/module-imports.test.ts`
 * enforces both.
 *
 * The drift module reads the snapshot through inventory's store (one network writer, shared
 * generations) and resolves entity links through inventory's model.
 */

export { getInventoryGeneration, subscribeInventoryGeneration } from "./inventory-store.js";
export type { InventoryGeneration } from "./inventory-store.js";
export { findHost, findService, hostHref, serviceHref } from "./model.js";
export type { InventoryModel } from "./model.js";
