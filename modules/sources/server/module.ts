import { SOURCES_UI } from "@deck/contract/modules/sources";
import { defineServerModule, type DisabledRouteDecl, type ModuleManifest, type ServiceOffer } from "@deck/module-sdk";

import { SOURCE_MESSAGES } from "./errors.js";
import { registerSourceRoutes } from "./route.js";
import { ensureCacheDir, pruneOrphanCaches, resolveCacheDir, SOURCES_ENV } from "./runtime.js";
import { SOURCE_READER, type SourceReader, type SourceStore } from "./store.js";

/** What every browsing route answers while the module is not running: an unknown source. */
const NOT_RUNNING: DisabledRouteDecl[] = ["tree", "file", "raw", "search"].map((route) => ({
  method: "GET",
  path: `/:id/${route}`,
  status: 404,
  body: { error: SOURCE_MESSAGES.SOURCE_NOT_FOUND, code: "SOURCE_NOT_FOUND" },
}));

/**
 * The sources module: the Docs and Configs pages, the owned-configs sections on the host and
 * service detail pages, and the read-only browsing routes over the sources the
 * `markdown-tree` and `file-tree` data sources serve.
 *
 * It is always on and has no config section: sources are the top-level `sources[]` instances,
 * and the cache root is the `DECK_SOURCES_CACHE_DIR` deployment setting. At init it creates
 * the cache root (a failure fails boot, exit 2) and releases the caches of sources no longer
 * declared. Its routes keep the pre-module `/api/sources` paths as a legacy alias. It reads
 * the stores through the `sources/reader` service each running data source offers, by the
 * authority {@link sourceFor} sets out; an id no reader answers for is 404 SOURCE_NOT_FOUND,
 * as every route is while this module is not running.
 */
export const SOURCES_MANIFEST: ModuleManifest = {
  // Identity and UI contributions are shared with the web half; the routes are server-only.
  ...SOURCES_UI,
  sharedEnv: [SOURCES_ENV.CACHE_DIR],
  services: { uses: [SOURCE_READER.name] },
  contributes: {
    ...SOURCES_UI.contributes,
    // Last, so nothing in the shared copy can replace the server's routes.
    routes: { legacyAliases: ["/api/sources"], whenDisabled: NOT_RUNNING },
  },
};

/** Readers that answered for an id they have no authority over, by kind of overreach. */
export interface SourceClaim {
  readonly sourceId: string;
  /** `ignored`: a declared source's id, owned by another module. `ambiguous`: several non-built-ins. */
  readonly kind: "ignored" | "ambiguous";
  readonly modules: readonly string[];
}

/**
 * The store that answers for `id`, by authority:
 * - a declared source (`declaredKind` set) is answered only by the reader of the module that
 *   owns its kind; any other reader that also serves the id is reported and ignored;
 * - an undeclared id is answered by a built-in reader that serves it, else by the one
 *   non-built-in reader that does. Two or more non-built-ins serving it answer nothing and
 *   are reported.
 */
export function sourceFor(
  id: string,
  declaredKind: string | undefined,
  offers: readonly ServiceOffer<SourceReader>[],
  report: (claim: SourceClaim) => void,
): SourceStore | undefined {
  const serving = (candidates: readonly ServiceOffer<SourceReader>[]) =>
    candidates.flatMap((offer) => {
      const store = offer.impl.get(id);
      return store === undefined ? [] : [{ module: offer.module, store }];
    });
  if (declaredKind !== undefined) {
    const owner = offers.find((offer) => offer.providerKinds.includes(declaredKind));
    const others = serving(offers.filter((offer) => offer !== owner));
    if (others.length > 0) report({ sourceId: id, kind: "ignored", modules: others.map(({ module }) => module) });
    return owner?.impl.get(id);
  }
  const builtin = serving(offers.filter((offer) => offer.builtin))[0];
  if (builtin !== undefined) return builtin.store;
  const external = serving(offers.filter((offer) => !offer.builtin));
  if (external.length > 1) {
    report({ sourceId: id, kind: "ambiguous", modules: external.map(({ module }) => module) });
    return undefined;
  }
  return external[0]?.store;
}

export const sourcesModule = defineServerModule(SOURCES_MANIFEST, (ctx) => {
  const cacheDir = resolveCacheDir(ctx.env);
  ensureCacheDir(cacheDir);
  // The declared sources' kinds decide whose reader answers for them.
  const declared = new Map(
    ctx.instances("sources")
      .filter((source): source is typeof source & { id: string; kind: string } => typeof source.id === "string" && typeof source.kind === "string")
      .map((source) => [source.id, source.kind]),
  );
  // Keep the cache of every declared source, whether or not its kind's module is running.
  pruneOrphanCaches(cacheDir, new Set(declared.keys()));
  // Each overreach is logged once per host.
  const reported = new Set<string>();
  const report = (claim: SourceClaim) => {
    const key = `${claim.kind} ${claim.sourceId} ${claim.modules.join(",")}`;
    if (reported.has(key)) return;
    reported.add(key);
    ctx.logger.warn(
      { event: "sources.reader-claim", ...claim },
      claim.kind === "ignored"
        ? `source "${claim.sourceId}" is declared for another module; the reader of ${claim.modules.join(", ")} is ignored for it`
        : `source "${claim.sourceId}" is served by several modules (${claim.modules.join(", ")}); none answers for it`,
    );
  };
  registerSourceRoutes(ctx.http, {
    sources: { get: (id) => sourceFor(id, declared.get(id), ctx.services.offers(SOURCE_READER), report) },
    logFailure: (event) => ctx.logger.warn({ event: "sources.failure", ...event }, "source.failure"),
  });
});
