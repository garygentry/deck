import { registerPage, registerSummaryFragment } from "../../registry/registry.js";
import { HealthHeaderSlot } from "../../shell/health-header/slot.js";
import { EndpointStatusSummary } from "./EndpointStatusSummary.js";
import { PortalPage } from "./PortalPage.js";

registerPage({
  id: "page:portal/overview",
  path: "/",
  label: "Portal",
  icon: "layout-grid",
  group: "Overview",
  component: PortalPage,
  order: -1,
});
registerSummaryFragment(HealthHeaderSlot, {
  id: "pill:portal/endpoints",
  component: EndpointStatusSummary,
});
