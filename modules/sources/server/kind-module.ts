import {
  defineServerModule,
  type JsonSchema,
  type ModuleManifest,
  type ProviderSpec,
  type ServerModule,
} from "@deck/module-sdk";
import type { Source } from "@deck/schema";

import { createBunGitSpawner, type GitSpawner } from "./acquire.js";
import { resolveCacheDir, SOURCES_ENV } from "./runtime.js";
import { createSourceStore, SOURCE_READER, type SourceStore } from "./store.js";
import type { SourceKind, SourceManifest } from "./tree.js";

export interface SourceKindModuleOptions {
  /** Build the git spawn seam for a kind's stores (default: the Bun-backed spawner). */
  createGit?: () => GitSpawner;
}

/**
 * The manifest of a source data-source module, named for its kind. Its instances are the
 * `sources[]` entries of that kind. A source is not bound to a host or service (its `owner`
 * names one), so the kind is not bindable: a binding of it is reported, not ignored.
 */
export function sourceKindManifest(kind: SourceKind, instanceSchema: JsonSchema): ModuleManifest {
  return {
    id: kind,
    version: "1.0.0",
    deckApi: "^0.1",
    // The cache root is shared with the other source kind and the `sources` module.
    sharedEnv: [SOURCES_ENV.CACHE_DIR],
    providerKinds: [{ kind, instanceList: "sources", instanceSchema, bindable: false, statusCapable: false }],
    services: { provides: [SOURCE_READER.name] },
  };
}

/**
 * A source data-source module: every `sources[]` entry of its kind becomes a store and a
 * provider of that kind with the source's id (an estate id: a clash fails boot). The store
 * reads the source's `credentialEnv` only through the reader the kernel issued for that
 * source. The module offers a reader over its stores as the `sources/reader` service, which
 * the `sources` module's routes read once this module has started.
 */
export function defineSourceKindModule(
  manifest: ModuleManifest,
  createProvider: (id: string, source: Source, store: SourceStore) => ProviderSpec<SourceManifest>,
  options: SourceKindModuleOptions = {},
): ServerModule {
  const kind = manifest.providerKinds![0]!.kind;
  const createGit = options.createGit ?? createBunGitSpawner;
  return defineServerModule(manifest, () => {}, {
    kinds: {
      [kind]: {
        instances: (instances, { env, envFor, services }) => {
          const cacheDir = resolveCacheDir(env);
          const git = createGit();
          const built = instances.map((instance) => {
            const source = instance as unknown as Source;
            return { source, store: createSourceStore(source, { cacheDir, git, env: envFor(instance) }) };
          });
          const stores = new Map(built.map(({ store }) => [store.id, store]));
          services.provide(SOURCE_READER, { get: (id) => stores.get(id) });
          return built.map(({ source, store }) => ({ provider: createProvider(source.id, source, store) }));
        },
      },
    },
  });
}
