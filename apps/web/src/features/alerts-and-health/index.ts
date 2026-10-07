import { registerPage, registerSummaryFragment } from "../../registry/registry.js";
import { HealthHeaderSlot } from "../../shell/health-header/slot.js";
import { AlertsSummary } from "./AlertsSummary.js";
import { MetricsSummary } from "./MetricsSummary.js";
import { MonitoringPage } from "./pages.js";

// Three eager registrations discovered by the shell's `import.meta.glob`: the /monitoring page and the
// two persistent HealthHeader summary fragments. Registration errors are intentionally uncaught so
// eager discovery fails loudly rather than silently omitting a required surface.
registerPage({
  id: "monitoring",
  path: "/monitoring",
  label: "Monitoring",
  icon: "activity",
  group: "Health",
  component: MonitoringPage,
});
registerSummaryFragment(HealthHeaderSlot, {
  id: "alerts-summary",
  component: AlertsSummary,
  order: 10,
});
registerSummaryFragment(HealthHeaderSlot, {
  id: "metrics-summary",
  component: MetricsSummary,
  order: 20,
});
