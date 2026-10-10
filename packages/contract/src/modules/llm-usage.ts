import type { WebModuleManifest } from "@deck/module-sdk";

/**
 * The llm-usage module's identity and UI contributions: its page, nav entry, header pill and
 * portal card. The server's manifest spreads this in, and the web half registers its
 * component table against it, so both read one copy of where each contribution attaches.
 * It is data only (no runtime imports), so the browser bundle can load it.
 */
export const LLM_USAGE_UI: WebModuleManifest = {
  id: "llm-usage",
  version: "1.0.0",
  deckApi: "^0.1",
  contributes: {
    pages: [{ id: "page:llm-usage/overview", path: "/usage", title: "LLM usage", icon: "gauge", component: "LlmUsagePage" }],
    nav: [{ id: "nav:llm-usage/overview", page: "page:llm-usage/overview", group: "health" }],
    extensions: [
      { id: "pill:llm-usage/summary", kind: "pill", attachTo: { slot: "app/topbar.status", order: 40 }, component: "LlmUsageSummary" },
      { id: "card:llm-usage/portal", kind: "widget", attachTo: { slot: "portal/summary" }, component: "LlmUsagePortalCard" },
    ],
  },
};
