import { LLM_USAGE_UI } from "@deck/contract/modules/llm-usage";
import { defineWebModule } from "@deck/module-sdk";

import { registerWebModule } from "../../registry/web-module.js";
import { LlmUsagePortalCard } from "./LlmUsagePortalCard.js";
import { LlmUsageSummary } from "./LlmUsageSummary.js";
import { LlmUsagePage } from "./pages.js";

// Where each component attaches (the page's path, the pill's and card's slots) is the
// module's manifest data; the UI manifest decides at runtime what renders.
export const llmUsageWebModule = defineWebModule(LLM_USAGE_UI, {
  components: { LlmUsagePage, LlmUsageSummary, LlmUsagePortalCard },
});

registerWebModule(llmUsageWebModule);
