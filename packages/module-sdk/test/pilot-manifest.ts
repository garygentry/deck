import type { ModuleManifest } from "../src/index.js";

/**
 * The llm-usage pilot expressed against the contract: config-gated, a config-named
 * credential env var, a legacy HTTP alias and a legacy health key.
 */
export const pilotManifest = {
  id: "llm-usage",
  version: "0.3.2",
  deckApi: "^0.1",
  enabledBy: { config: true },
  envFromConfig: ["/claude/statusLine/credentialEnv"],
  config: {
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        idlePause: { type: "string" },
        thresholds: {
          type: "object",
          properties: { warn: { type: "number" }, danger: { type: "number" } },
        },
        claude: {
          type: "object",
          properties: {
            statusLine: { type: "object", properties: { credentialEnv: { type: "string" } } },
          },
        },
      },
    },
    ownership: { "": "overlay" },
    findings: [
      {
        code: "LLM_USAGE_THRESHOLDS_INVERTED",
        severity: "error",
        summary: "The warn threshold exceeds the danger threshold.",
        fix: "Set warn at or below danger.",
      },
    ],
  },
  contributes: {
    pages: [{ id: "page:llm-usage/overview", path: "/usage", title: "LLM usage", icon: "gauge", component: "UsagePage" }],
    nav: [{ id: "nav:llm-usage/main", page: "page:llm-usage/overview", group: "health" }],
    extensions: [
      { id: "pill:llm-usage/summary", kind: "pill", attachTo: { slot: "app/topbar.status", order: 40 }, component: "UsagePill" },
      { id: "widget:llm-usage/summary", kind: "widget", attachTo: { slot: "portal/summary" }, component: "UsageSummaryWidget" },
    ],
    statusMaps: { "usage-pct": { rules: [{ lt: 75, tone: "ok" }, { lt: 90, tone: "warn" }, { tone: "danger" }] } },
    routes: { legacyAliases: ["/api/llm-usage"] },
  },
  health: { legacyKey: "llmUsage" },
} satisfies ModuleManifest;
