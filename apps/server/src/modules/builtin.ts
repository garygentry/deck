import type { ServerModule } from "@deck/module-sdk";

import { actionsModule } from "../../../../modules/actions/server/module.js";
import type { DeckConfig } from "../contract/index.js";
import { driftModule } from "../../../../modules/drift/server/module.js";
import { inventoryModule } from "../../../../modules/inventory/server/module.js";
import { llmUsageModule } from "../../../../modules/llm-usage/server/module.js";
import { metricsModule } from "../../../../modules/metrics/server/module.js";
import { monitoringModule } from "../../../../modules/monitoring/server/module.js";
import { alertmanagerModule } from "../../../../modules/alertmanager/server/module.js";
import { dockerModule } from "../../../../modules/docker/server/module.js";
import { fileTreeModule } from "../providers/file-tree/module.js";
import { gatusModule } from "../../../../modules/gatus/server/module.js";
import { httpHealthModule } from "../../../../modules/http-health/server/module.js";
import { httpJsonModule } from "../providers/http-json/module.js";
import { linkModule } from "../../../../modules/link/server/module.js";
import { markdownTreeModule } from "../providers/markdown-tree/module.js";
import { prometheusModule } from "../../../../modules/prometheus/server/module.js";
import { remoteModule } from "../providers/remote/module.js";
import { snapshotModule } from "../../../../modules/snapshot/server/module.js";
import { portalModule } from "../../../../modules/portal/server/module.js";
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
  remoteModule,
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
