import { MONITORING_UI } from "@deck/contract/modules/monitoring";
import { defineWebModule } from "@deck/module-sdk";

import { registerWebModule } from "../../registry/web-module.js";
import { AlertsSummary } from "./AlertsSummary.js";
import { MetricsSummary } from "./MetricsSummary.js";
import { MonitoringPage } from "./pages.js";

// Where each component attaches (the page's path, the pills' slot and order) is the monitoring
// module's manifest data; the UI manifest decides at runtime what renders. The metrics module
// contributes no UI, so this feature serves monitoring alone.
export const monitoringWebModule = defineWebModule(MONITORING_UI, {
  components: { MonitoringPage, AlertsSummary, MetricsSummary },
});

registerWebModule(monitoringWebModule);
