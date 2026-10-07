import { registerCard, registerPage, registerSummaryFragment } from "../../registry/registry.js";
import { HealthHeaderSlot } from "../../shell/health-header/slot.js";
import { PORTAL_SUMMARY_SLOT } from "../../shell/portal-summary-slot.js";
import { LlmUsagePortalCard } from "./LlmUsagePortalCard.js";
import { LlmUsageSummary } from "./LlmUsageSummary.js";
import { LlmUsagePage } from "./pages.js";

registerPage({
  id: "page:llm-usage/overview",
  path: "/usage",
  label: "LLM usage",
  icon: "gauge",
  group: "Health",
  component: LlmUsagePage,
});
registerSummaryFragment(HealthHeaderSlot, {
  id: "pill:llm-usage/summary",
  component: LlmUsageSummary,
  order: 40,
});
registerCard({ id: "card:llm-usage/portal", slot: PORTAL_SUMMARY_SLOT, component: LlmUsagePortalCard });
