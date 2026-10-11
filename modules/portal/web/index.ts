import { PORTAL_UI } from "@deck/contract/modules/portal";
import { defineWebModule } from "@deck/module-sdk";

import { registerWebModule } from "@/registry/web-module.js";
import { EndpointStatusSummary } from "./EndpointStatusSummary.js";
import { PortalGroupsWidget } from "./PortalGroupsWidget.js";
import { PortalPage } from "./PortalPage.js";

// Where each component attaches (the page's path, the pill's slot), the portal/summary slot it
// hosts, its portal/groups widget type and the page's default layout are the module's manifest
// data; the UI manifest decides at runtime what renders.
export const portalWebModule = defineWebModule(PORTAL_UI, {
  components: { PortalPage, EndpointStatusSummary, PortalGroupsWidget },
});

registerWebModule(portalWebModule);
