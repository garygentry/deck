import type { ServerModule } from "@deck/module-sdk";

import { actionsModule } from "../actions/module.js";
import type { DeckConfig } from "../contract/index.js";
import { driftModule } from "../drift/module.js";
import { inventoryModule } from "../inventory/module.js";
import { llmUsageModule } from "../llm-usage/module.js";
import { metricsModule } from "../metrics/module.js";
import { monitoringModule } from "../monitoring/module.js";
import { alertmanagerModule } from "../providers/alertmanager/module.js";
import { dockerModule } from "../providers/docker/module.js";
import { fileTreeModule } from "../providers/file-tree/module.js";
import { gatusModule } from "../providers/gatus/module.js";
import { httpHealthModule } from "../providers/http-health/module.js";
import { httpJsonModule } from "../providers/http-json/module.js";
import { linkModule } from "../providers/link/module.js";
import { markdownTreeModule } from "../providers/markdown-tree/module.js";
import { prometheusModule } from "../providers/prometheus/module.js";
import { snapshotModule } from "../providers/snapshot/module.js";
import { portalModule } from "../portal/module.js";
import { sourcesModule } from "../sources/module.js";
import { kindRuntimes, planModules, type KindRuntime } from "./host.js";

/**
 * Built-in server modules, in no particular order (the host orders them by `dependsOn`).
 * A static list: each built-in adds its `module.ts` export here.
 */
export const BUILTIN_MODULES: readonly ServerModule<any>[] = [
  actionsModule,
  alertmanagerModule,
  dockerModule,
  driftModule,
  fileTreeModule,
  gatusModule,
  httpHealthModule,
  httpJsonModule,
  inventoryModule,
  linkModule,
  llmUsageModule,
  markdownTreeModule,
  metricsModule,
  monitoringModule,
  portalModule,
  prometheusModule,
  snapshotModule,
  sourcesModule,
];

/**
 * The provider-kind handlers of the built-in modules enabled for `config` (planned from
 * their manifests with the process env), for registering providers outside a module host.
 */
export function builtinKindHandlers(
  config: DeckConfig,
  env: Readonly<Record<string, string | undefined>> = process.env,
): ReadonlyMap<string, KindRuntime> {
  const sections = (config as { modules?: Record<string, unknown> }).modules;
  const { plan, usable, envOwners, builtinIds } = planModules({
    modules: BUILTIN_MODULES,
    sectionOf: (id) => sections?.[id],
    env,
    builtins: new Set(BUILTIN_MODULES),
  });
  const enabled = plan.filter((entry) => entry.enabled).map((entry) => usable.get(entry.id)!);
  return kindRuntimes(enabled, env, undefined, undefined, envOwners, undefined, builtinIds);
}
