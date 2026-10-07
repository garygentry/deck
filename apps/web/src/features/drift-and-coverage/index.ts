import { HealthHeaderSlot } from "../../shell/health-header/slot.js";
import {
  registerEntityFragment,
  registerPage,
  registerSummaryFragment,
} from "../../registry/registry.js";
import { DriftHealthSummary } from "./DriftHealthSummary.js";
import { DriftPage, FindingsFragment } from "./pages.js";

// Exactly four eager registrations discovered by `import.meta.glob`. All four
// surfaces subscribe to the shared drift generation store; none polls or derives
// on its own. Registration errors are intentionally uncaught so eager discovery
// fails loudly rather than silently omitting a required surface.
registerPage({
  id: "drift",
  path: "/drift",
  label: "Drift",
  icon: "git-compare",
  group: "Health",
  component: DriftPage,
});
registerEntityFragment({
  id: "drift-host-findings",
  entity: "host",
  slot: "findings",
  component: FindingsFragment,
});
registerEntityFragment({
  id: "drift-service-findings",
  entity: "service",
  slot: "findings",
  component: FindingsFragment,
});
registerSummaryFragment(HealthHeaderSlot, {
  id: "drift-summary",
  component: DriftHealthSummary,
});
