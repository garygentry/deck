import { defineServerModule, type ModuleManifest } from "@deck/module-sdk";

/**
 * The inventory module: the hosts and services pages and their detail pages. The estate's
 * `hosts` and `services` stay kernel config, since every module references them; this
 * module only renders them, so it has no config section and no server code.
 */
export const INVENTORY_MANIFEST: ModuleManifest = {
  id: "inventory",
  version: "0.1.0",
  deckApi: "^0.1",
  // Inventory renders declared hosts and services beside the snapshot's observed reality.
  dependsOn: ["snapshot"],
  contributes: {
    pages: [
      { id: "page:inventory/hosts", path: "/hosts", title: "Hosts", icon: "server", component: "HostsPage" },
      { id: "page:inventory/services", path: "/services", title: "Services", icon: "boxes", component: "ServicesPage" },
      { id: "page:inventory/host-detail", path: "/hosts/:name", title: "Host", component: "HostDetailPage" },
      { id: "page:inventory/service-detail", path: "/services/:host/:name", title: "Service", component: "ServiceDetailPage" },
    ],
    nav: [
      { id: "nav:inventory/hosts", page: "page:inventory/hosts", group: "inventory" },
      { id: "nav:inventory/services", page: "page:inventory/services", group: "inventory" },
    ],
  },
};

export const inventoryModule = defineServerModule(INVENTORY_MANIFEST, () => {});
