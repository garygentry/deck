import {
  defineServerModule,
  type ModuleManifest,
  type ServerModule,
  type ServerModuleInit,
  type TaskHandle,
} from "@deck/module-sdk";
import pino, { type Logger } from "pino";

import { ACTIONS_MANIFEST } from "../../src/actions/module.js";
import { DRIFT_MANIFEST } from "../../src/drift/module.js";
import { INVENTORY_MANIFEST } from "../../src/inventory/module.js";
import { LLM_USAGE_MANIFEST } from "../../../../modules/llm-usage/server/module.js";
import { METRICS_MANIFEST } from "../../src/metrics/module.js";
import { MONITORING_MANIFEST } from "../../src/monitoring/module.js";
import { ALERTMANAGER_MANIFEST } from "../../src/providers/alertmanager/module.js";
import { DOCKER_MANIFEST } from "../../src/providers/docker/module.js";
import { FILE_TREE_MANIFEST } from "../../src/providers/file-tree/module.js";
import { GATUS_MANIFEST } from "../../src/providers/gatus/module.js";
import { HTTP_HEALTH_MANIFEST } from "../../src/providers/http-health/module.js";
import { HTTP_JSON_MANIFEST } from "../../src/providers/http-json/module.js";
import { LINK_MANIFEST } from "../../src/providers/link/module.js";
import { MARKDOWN_TREE_MANIFEST } from "../../src/providers/markdown-tree/module.js";
import { PROMETHEUS_MANIFEST } from "../../src/providers/prometheus/module.js";
import { REMOTE_MANIFEST } from "../../src/providers/remote/module.js";
import { SNAPSHOT_MANIFEST } from "../../src/providers/snapshot/module.js";
import { createModuleHost, type ModuleHostOptions } from "../../src/modules/host.js";
import { PORTAL_MANIFEST } from "../../src/portal/module.js";
import { SOURCES_MANIFEST } from "../../src/sources/module.js";

/** A test module: `deckApi: "^0.1"`, always on unless the manifest says otherwise. */
export function testModule(
  manifest: Partial<ModuleManifest> & { id: string },
  init: ServerModuleInit = () => {},
): ServerModule {
  return defineServerModule({ version: "1.0.0", deckApi: "^0.1", ...manifest }, init);
}

/** A pino logger whose JSON lines are captured for assertions. */
export function captureLogger(): { logger: Logger; lines: Record<string, unknown>[] } {
  const lines: Record<string, unknown>[] = [];
  const logger = pino({ level: "debug" }, { write: (line: string) => void lines.push(JSON.parse(line)) });
  return { logger, lines };
}

const inertHandle = (): TaskHandle => ({ wake() {}, async runNow() {}, async stop() {} });

/**
 * The built-in modules' manifests. Imported from each module, never from `modules/builtin.js`:
 * tests mock that file with factories that import this util, and importing it here would
 * make the mock await itself (a hang). `module-host.test.ts` keeps this list in step.
 */
export const BUILTIN_MANIFESTS: ReadonlySet<ModuleManifest> = new Set([
  ACTIONS_MANIFEST,
  ALERTMANAGER_MANIFEST,
  DOCKER_MANIFEST,
  DRIFT_MANIFEST,
  FILE_TREE_MANIFEST,
  GATUS_MANIFEST,
  HTTP_HEALTH_MANIFEST,
  HTTP_JSON_MANIFEST,
  INVENTORY_MANIFEST,
  LINK_MANIFEST,
  LLM_USAGE_MANIFEST,
  MARKDOWN_TREE_MANIFEST,
  METRICS_MANIFEST,
  MONITORING_MANIFEST,
  PORTAL_MANIFEST,
  PROMETHEUS_MANIFEST,
  REMOTE_MANIFEST,
  SNAPSHOT_MANIFEST,
  SOURCES_MANIFEST,
]);

/**
 * A host over the given modules with captured logs and no registry side effects. Modules
 * carrying a built-in's manifest (the built-ins themselves, or instances their factories
 * build) count as built-in unless `builtins` says otherwise.
 */
export function testHost(modules: ServerModule<any>[], options: Partial<ModuleHostOptions> = {}) {
  const { logger, lines } = captureLogger();
  const host = createModuleHost({
    modules,
    builtins: new Set(modules.filter((module) => BUILTIN_MANIFESTS.has(module.manifest))),
    sectionOf: () => undefined,
    env: {},
    logger,
    registerProvider: () => inertHandle(),
    ...options,
  });
  return { host, lines };
}
