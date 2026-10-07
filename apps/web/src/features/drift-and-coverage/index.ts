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
  id: "page:drift/overview",
  path: "/drift",
  label: "Drift",
  icon: "git-compare",
  group: "Health",
  component: DriftPage,
});
registerEntityFragment({
  id: "section:drift/host-findings",
  entity: "host",
  section: "findings",
  title: "Findings",
  order: 10,
  component: FindingsFragment,
});
registerEntityFragment({
  id: "section:drift/service-findings",
  entity: "service",
  section: "findings",
  title: "Findings",
  order: 10,
  component: FindingsFragment,
});
registerSummaryFragment(HealthHeaderSlot, {
  id: "pill:drift/summary",
  component: DriftHealthSummary,
});
