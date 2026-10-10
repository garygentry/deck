import { INVENTORY_UI } from "@deck/contract/modules/inventory";
import { defineServerModule, type ModuleManifest } from "@deck/module-sdk";

/**
 * The inventory module: the hosts and services pages and their detail pages. The estate's
 * `hosts` and `services` stay kernel config, since every module references them; this
 * module only renders them, so it has no config section and no server code.
 */
export const INVENTORY_MANIFEST: ModuleManifest = {
  // Identity and UI contributions are shared with the web half.
  ...INVENTORY_UI,
  // Inventory renders declared hosts and services beside the snapshot's observed reality.
  dependsOn: ["snapshot"],
};

export const inventoryModule = defineServerModule(INVENTORY_MANIFEST, () => {});
