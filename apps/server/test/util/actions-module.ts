import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Logger } from "pino";
import { vi } from "vitest";

import { createActionsModule, type ActionsModuleOptions } from "../../../../modules/actions/server/module.js";
import type { DeckConfig } from "../../src/contract/index.js";
import { createApp, planningRouteTable, RESERVED_ROOT_PATHS } from "../../src/server/app.js";
import { testHost } from "./modules.js";

export const ACTIONS_FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/actions-estate");

/** The actions fixture estate (`modules.actions.actions` declares restart-quiet, deploy, …). */
export function actionsFixtureConfig(): DeckConfig {
  return JSON.parse(readFileSync(join(ACTIONS_FIXTURES_DIR, "config.json"), "utf8")) as DeckConfig;
}

export interface ActionsAppOptions extends ActionsModuleOptions {
  config?: DeckConfig;
  /** The env the host and module see; DECK_ACTIONS_ENABLED switches the module on. */
  env?: Record<string, string>;
  webDistDir?: string;
}

/**
 * A deck app with the actions module composed as boot composes it: planned against the
 * kernel route table, started, and mounted by the app.
 */
export async function actionsApp(options: ActionsAppOptions = {}) {
  const config = options.config ?? actionsFixtureConfig();
  const sections = (config as { modules?: Record<string, unknown> }).modules;
  const fixture = testHost([createActionsModule(options)], {
    sectionOf: (id) => sections?.[id],
    env: options.env ?? {},
    kernelRoutes: planningRouteTable(),
    reservedRootPaths: RESERVED_ROOT_PATHS,
  });
  await fixture.host.start();
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
  const providers = { read: () => undefined, count: () => 0, listHealth: () => ({}), listProviders: () => [], setProjections: () => {} };
  const app = createApp({
    config,
    providers,
    logger,
    modules: fixture.host,
    ...(options.webDistDir === undefined ? {} : { webDistDir: options.webDistDir }),
  });
  return { ...fixture, app };
}
