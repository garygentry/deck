import { INVENTORY_UI } from "@deck/contract/modules/inventory";
import { defineWebModule } from "@deck/module-sdk";

import { registerWebModule } from "@/registry/web-module.js";
import { HostDetailPage, HostsPage, ServiceDetailPage, ServicesPage } from "./pages.js";

// The Hosts and Services lists and their two detail routes (routed, not in the nav). Their
// paths, titles, icons and nav group are the module's manifest data; the UI manifest decides
// at runtime what renders.
export const inventoryWebModule = defineWebModule(INVENTORY_UI, {
  components: { HostsPage, ServicesPage, HostDetailPage, ServiceDetailPage },
});

registerWebModule(inventoryWebModule);
