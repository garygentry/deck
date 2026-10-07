import { defineServerModule, type JsonSchema, type ModuleManifest } from "@deck/module-sdk";

import { openAuditStore } from "./audit.js";
import type { ActionsModuleConfig } from "./config.generated.js";
import { createActionExecutor } from "./executor.js";
import { ACTION_REFUSAL_CODES, ACTION_REFUSAL_STATUS, registerActionRoutes } from "./route.js";
import { ACTIONS_ENV, resolveActionsRuntime } from "./runtime.js";
import { createBunRunnerSpawner, type RunnerSpawner } from "./spawn.js";
import schema from "./schema.json" with { type: "json" };

/** What every action route but the probe answers while the capability is off. */
const DISABLED_REFUSAL = {
  error: "The actions capability is disabled on this deck instance.",
  code: ACTION_REFUSAL_CODES.ACTIONS_DISABLED,
};
const DISABLED_STATUS = ACTION_REFUSAL_STATUS.ACTIONS_DISABLED;

/**
 * The governed-actions module: the `modules.actions.actions` declarations, the run, cancel
 * and audit routes, the runner allowlist, the executor and the audit store.
 *
 * It runs only when `DECK_ACTIONS_ENABLED` is `true` or `1`. Switched off, no module code
 * runs: its prefixes answer the fixed `whenDisabled` responses instead, so `/api/actions`
 * still reports `{"enabled": false}` and every write or audit route refuses with 403
 * ACTIONS_DISABLED, as before the module existed. Its routes keep the pre-module
 * `/api/actions` paths as a legacy alias, and its data dir is the pre-module
 * `$DECK_DATA_DIR/actions`. Governance is fixed in code here and is not configurable: the
 * runtime, executor and audit store exist only inside this module's init, and the settings
 * they come from are env names this module owns, which no other module can declare.
 */
export const ACTIONS_MANIFEST: ModuleManifest = {
  id: "actions",
  version: "1.0.0",
  deckApi: "^0.1",
  enabledBy: { env: ACTIONS_ENV.ENABLED },
  env: [ACTIONS_ENV.ENABLED, ACTIONS_ENV.TIMEOUT_MS, ACTIONS_ENV.RUNNERS_FILE],
  dataDir: { legacyPath: "actions" },
  config: {
    schema: schema as unknown as JsonSchema,
    ownership: { "": "overlay" },
    // Param names are not identity-checked: deck has always accepted duplicates there.
    identity: { actions: ["id"] },
    references: ["actions[].target"],
  },
  contributes: {
    pages: [{ id: "page:actions/overview", path: "/actions", title: "Actions", icon: "zap", component: "ActionsPage" }],
    nav: [{ id: "nav:actions/overview", page: "page:actions/overview", group: "operate" }],
    routes: {
      legacyAliases: ["/api/actions"],
      whenDisabled: [
        { method: "GET", path: "", status: 200, body: { enabled: false } },
        { method: "POST", path: "/:id", status: DISABLED_STATUS, body: DISABLED_REFUSAL },
        { method: "POST", path: "/runs/:runId/cancel", status: DISABLED_STATUS, body: DISABLED_REFUSAL },
        { method: "GET", path: "/audit", status: DISABLED_STATUS, body: DISABLED_REFUSAL },
        { method: "GET", path: "/audit/:runId", status: DISABLED_STATUS, body: DISABLED_REFUSAL },
      ],
    },
  },
};

/**
 * How long shutdown waits for in-flight runs to be cancelled and audited. It covers a
 * runner's SIGTERM → SIGKILL escalation plus draining its pipes, and fits deck's module stage.
 */
export const ACTIONS_STOP_TIMEOUT_MS = 4_000;

export interface ActionsModuleOptions {
  /** Build the runner spawner (default: the real Bun process spawner; tests inject a fake). */
  createSpawner?: () => RunnerSpawner;
  /** Shutdown bound for cancelling in-flight runs (default {@link ACTIONS_STOP_TIMEOUT_MS}). */
  stopTimeoutMs?: number;
}

export function createActionsModule(options: ActionsModuleOptions = {}) {
  const createSpawner = options.createSpawner ?? createBunRunnerSpawner;
  return defineServerModule<ActionsModuleConfig>(ACTIONS_MANIFEST, (ctx) => {
    // A missing or invalid DECK_DATA_DIR, DECK_RUNNERS_FILE, runner manifest or timeout
    // throws, failing boot: a half-configured write path must never serve.
    const dataDir = ctx.dataDir();
    const env = Object.fromEntries(Object.values(ACTIONS_ENV).map((name) => [name, ctx.env.get(name)]));
    const runtime = resolveActionsRuntime(env);
    const audit = openAuditStore(dataDir, ctx.logger);
    const executor = createActionExecutor({
      spawner: createSpawner(),
      audit,
      timeoutMs: runtime.timeoutMs,
      logger: ctx.logger,
    });
    // Cancel in-flight runs the moment shutdown begins; this settles once each is audited.
    ctx.onStop(async () => void (await executor.cancelAll()), {
      early: true,
      timeoutMs: options.stopTimeoutMs ?? ACTIONS_STOP_TIMEOUT_MS,
    });
    registerActionRoutes(ctx.http, {
      declared: () => ctx.config?.actions ?? [],
      logger: ctx.logger,
      actions: { runtime, executor, audit },
    });
  });
}

export const actionsModule = createActionsModule();
