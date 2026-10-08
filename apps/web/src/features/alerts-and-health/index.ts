import { MONITORING_UI } from "@deck/contract/modules/monitoring";
import { defineWebModule } from "@deck/module-sdk";
import type { ComponentType } from "react";

import { registerWebModule } from "../../registry/web-module.js";
import type { HealthSummary } from "../../shell/health-header/health-summary.js";
// Declares `app/topbar.status` before the pills attach to it, whatever imports this first.
import "../../shell/health-header/slot.js";
import { AlertsSummary } from "./AlertsSummary.js";
import { MetricsSummary } from "./MetricsSummary.js";
import { MonitoringPage } from "./pages.js";

// Where each component attaches (the page's path, the pills' slot and order) is the monitoring
// module's manifest data; the UI manifest decides at runtime what renders. The metrics module
// contributes no UI, so this feature serves monitoring alone.
export const monitoringWebModule = defineWebModule(MONITORING_UI, {
  // The pills keep the health-header slot's component contract.
  components: { MonitoringPage, AlertsSummary, MetricsSummary } satisfies {
    MonitoringPage: ComponentType;
    AlertsSummary: ComponentType<HealthSummary>;
    MetricsSummary: ComponentType<HealthSummary>;
  },
});

registerWebModule(monitoringWebModule);
