import { LLM_USAGE_UI } from "@deck/contract/modules/llm-usage";
import { defineServerModule, type JsonSchema, type ModuleManifest } from "@deck/module-sdk";

import { LlmUsageCollector, type CollectorDeps } from "./collector.js";
import { resolveLlmUsageSection, type ResolvedLlmUsageConfig } from "./config.js";
import type { LlmUsage } from "./config.generated.js";
import { LLM_USAGE_INVALID, llmUsageValues } from "./rule.js";
import { registerLlmUsageRoutes } from "./routes.js";
import schema from "../schema.json" with { type: "json" };

/**
 * The llm-usage module: Claude Code and Codex subscription plan-usage limits.
 *
 * It is always on, with no `enabledBy`: without a `modules.llm-usage` section it still
 * answers `GET /api/llm-usage` with `enabled: false` (which the web reads as "not
 * configured"), so a section for a switched-off module cannot arise. Its routes keep the
 * pre-module `/api/llm-usage` paths as a legacy alias, and its health data keeps the
 * `/api/health.llmUsage` field.
 */
export const LLM_USAGE_MANIFEST: ModuleManifest = {
  // Identity and UI contributions are shared with the web half.
  ...LLM_USAGE_UI,
  contributes: {
    ...LLM_USAGE_UI.contributes,
    // Routes are server-only.
    routes: { legacyAliases: ["/api/llm-usage"] },
  },
  // The section names the env var holding the statusLine ingest token, never the token.
  envFromConfig: ["/claude/statusLine/credentialEnv"],
  config: {
    schema: schema as JsonSchema,
    ownership: { "": "overlay" },
    findings: [LLM_USAGE_INVALID],
  },
  health: { legacyKey: "llmUsage" },
};

export interface LlmUsageModuleOptions {
  /** Build the collector from the resolved section and the scheduling deps (tests inject upstream fakes). */
  createCollector?: (config: ResolvedLlmUsageConfig, deps: CollectorDeps) => LlmUsageCollector;
}

export function createLlmUsageModule(options: LlmUsageModuleOptions = {}) {
  const createCollector = options.createCollector ?? ((config, deps) => new LlmUsageCollector(config, deps));
  return defineServerModule<LlmUsage>(LLM_USAGE_MANIFEST, (ctx) => {
    // A value the schema and rule let through but deck cannot run with throws, failing boot.
    const config = resolveLlmUsageSection(ctx.config);
    if (config === null) {
      registerLlmUsageRoutes(ctx.http, null, () => ctx.clock.now());
      ctx.health.report(() => ({ state: "ok", detail: "not configured" }));
      return;
    }

    // The ingest token is read from the env var the config names, never from the config.
    const tokenEnv = config.claude?.statusLineCredentialEnv;
    const ingestToken = tokenEnv ? ctx.env.get(tokenEnv) || null : null;
    if (tokenEnv && ingestToken === null) {
      ctx.logger.warn({ event: "llm-usage.ingest-disabled", credentialEnv: tokenEnv }, "statusLine ingest env var unset; ingest route not registered");
    }

    const collector = createCollector(config, {
      now: () => ctx.clock.now(),
      schedule: (task) => ctx.scheduler.schedule(task),
    });
    ctx.onStop(() => collector.stop());
    registerLlmUsageRoutes(ctx.http, { collector, ingestToken }, () => ctx.clock.now());
    ctx.health.report(() => {
      const data = collector.health();
      return { state: data.consecutiveErrors > 0 ? "degraded" : "ok", data: { ...data } };
    });
  }, { configRules: [llmUsageValues] });
}

export const llmUsageModule = createLlmUsageModule();
