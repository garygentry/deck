import type { WebModuleManifest } from "@deck/module-sdk";

/**
 * The inventory module's identity and UI contributions: the Hosts and Services list pages in
 * the inventory nav group, and their host and service detail pages, which are routed but not
 * listed. The server's manifest spreads this in, and the web half registers its component
 * table against it, so both read one copy of where each contribution attaches. It is data
 * only (no runtime imports), so the browser bundle can load it.
 */
export const INVENTORY_UI: WebModuleManifest = {
  id: "inventory",
  version: "0.1.0",
  deckApi: "^0.1",
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
