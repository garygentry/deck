import type { ServerModule } from "@deck/module-sdk";
import type { Logger } from "pino";
import { vi } from "vitest";

import type { DeckConfig } from "../../src/contract/index.js";
import { registerAllProviders } from "../../src/providers/index.js";
import { listHealth, listProviders, providerCount, read, setProjections } from "../../src/providers/registry.js";
import { createApp, planningRouteTable, RESERVED_ROOT_PATHS } from "../../src/server/app.js";
import type { GitSpawner } from "../../src/sources/acquire.js";
import { createFileTreeModule } from "../../src/providers/file-tree/module.js";
import { createMarkdownTreeModule } from "../../src/providers/markdown-tree/module.js";
import { sourcesModule } from "../../src/sources/module.js";
import { createFakeGitSpawner } from "./fake-git-spawner.js";
import { testHost } from "./modules.js";

/** The markdown-tree, file-tree and sources modules, the data sources with `createGit`. */
export function sourceModules(createGit: () => GitSpawner = () => createFakeGitSpawner({})): ServerModule[] {
  return [createMarkdownTreeModule({ createGit }), createFileTreeModule({ createGit }), sourcesModule];
}

export interface SourcesAppOptions {
  /** The env the host and modules see (DECK_SOURCES_CACHE_DIR, credentials). */
  env?: Record<string, string>;
  /** The git spawn seam for every store (default: a fake that spawns nothing). */
  createGit?: () => GitSpawner;
  /** The modules to run (default: {@link sourceModules}). */
  modules?: readonly ServerModule[];
}

/**
 * A deck app with the source modules composed as boot composes them: planned against the
 * kernel route table, their kind handlers run over `config` (registering the providers in the
 * process registry; stop it with `stopScheduler`), started, and mounted by the app.
 */
export async function sourcesApp(config: DeckConfig, options: SourcesAppOptions = {}) {
  const modules = options.modules ?? sourceModules(options.createGit);
  const fixture = testHost([...modules], {
    env: options.env ?? {},
    instancesOf: (list) => config[list] ?? [],
    kernelRoutes: planningRouteTable(),
    reservedRootPaths: RESERVED_ROOT_PATHS,
  });
  registerAllProviders(config, fixture.host.kindHandlers());
  await fixture.host.start();
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
  const app = createApp({
    config,
    providers: { read, count: providerCount, listHealth, listProviders, setProjections },
    logger,
    modules: fixture.host,
  });
  return { ...fixture, app };
}
