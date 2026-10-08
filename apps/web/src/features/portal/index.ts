import { PORTAL_UI } from "@deck/contract/modules/portal";
import { defineWebModule } from "@deck/module-sdk";

import { registerWebModule } from "../../registry/web-module.js";
import { EndpointStatusSummary } from "./EndpointStatusSummary.js";
import { PortalPage } from "./PortalPage.js";

// Where each component attaches (the page's path, the pill's slot) and the portal/summary slot
// it hosts are the module's manifest data; the UI manifest decides at runtime what renders.
export const portalWebModule = defineWebModule(PORTAL_UI, {
  components: { PortalPage, EndpointStatusSummary },
});

registerWebModule(portalWebModule);
