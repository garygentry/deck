/**
 * Boot-time runtime types and env-var names for the sources capability.
 *
 * `SourcesRuntime`, `SourcesDeps`, and `SOURCES_ENV` are DEFINED here (deck-deployment
 * settings, NOT estate config — the frozen `Source` contract carries no timing/cache
 * knobs). `resolveSourcesRuntime(config, env)` implements their resolution once at boot;
 * its concrete impl lands in item 006.
 */

import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Source } from "@deck/schema";

import type { DeckConfig } from "../contract/index.js";
import { createBunGitSpawner, type GitSpawner } from "./acquire.js";
import { createSourceReader, createSourceStore, type SourceReader, type SourceStore } from "./store.js";
import { SOURCE_KINDS } from "./tree.js";

/**
 * Deck-deployment settings for the sources capability, resolved once in boot() from env.
 * Deck settings, NOT estate config fields (CON-03).
 */
export interface SourcesRuntime {
  /** On-disk cache root for acquired git trees; DECK_SOURCES_CACHE_DIR. */
  cacheDir: string;
  /** The declared sources this runtime built stores for (post-validation). */
  readonly sources: readonly Source[];
}

/**
 * The sources dependency bundle. `stores` is threaded to `registerAllProviders` via
 * `ProviderRuntimeOptions` (so registration stays the single register() site) and the same
 * `reader` is injected into `createApp` as `AppDeps.sources`.
 */
export interface SourcesDeps {
  runtime: SourcesRuntime;
  /** Per-source stores, keyed insertion-ordered; feeds both the providers and the reader. */
  stores: ReadonlyMap<string, SourceStore>;
  reader: SourceReader;
}

/** Environment variable names for the sources capability (deck-deployment settings). */
export const SOURCES_ENV = {
  /** On-disk cache root for acquired git trees (REQ-FRESH-05). */
  CACHE_DIR: "DECK_SOURCES_CACHE_DIR",
} as const;

/** Optional injected collaborators (tests substitute a fake GitSpawner; prod uses Bun). */
export interface ResolveSourcesOptions {
  /** Git spawn seam shared by every store; defaults to the Bun-backed production spawner. */
  readonly git?: GitSpawner;
}

/**
 * Resolve the sources capability once from config + env (mirrors `resolveActionsRuntime`).
 * Deck-deployment settings, NOT estate config fields (CON-03) — the frozen `Source` contract
 * carries no cache/timing knobs. Builds a `SourceStore` per SUPPORTED-kind Source (unknown
 * kinds are skipped here AND, redundantly, in the registration loop — REQ-SRC-05/SC-12),
 * prunes orphaned cache dirs (REQ-FRESH-05), and returns the DI bundle threaded into
 * registration + createApp.
 *
 * Fail-fast posture (mirrors resolveActionsRuntime): a cache dir that cannot be created
 * throws `SOURCES_CONFIG_INVALID`; boot() maps it to classified stderr + exit(2), so the
 * server never boots a half-configured sources capability.
 *
 * @param config  The loaded, validated DeckConfig (its `sources?: Source[]`, REQ-SRC-01).
 * @param env     Process environment (defaults to process.env; injectable for tests).
 * @param opts    Optional injected collaborators (a fake GitSpawner for tests).
 * @returns       SourcesDeps { runtime, stores, reader } (00 §6).
 * @throws {Error & { code: "SOURCES_CONFIG_INVALID" }} when the cache dir is unusable.
 */
export function resolveSourcesRuntime(
  config: DeckConfig,
  env: NodeJS.ProcessEnv = process.env,
  opts: ResolveSourcesOptions = {},
): SourcesDeps {
  const cacheDir = resolveCacheDir(env);
  const git = opts.git ?? createBunGitSpawner(); // Bun.spawn is lazy inside spawn() (02)

  const declared = config.sources ?? [];
  const supported = declared.filter(isSupportedKind); // unknown kinds dropped (REQ-SRC-05)

  const stores = new Map<string, SourceStore>();
  for (const src of supported) {
    // Duplicate ids are NOT pre-empted here: the registration loop (item 007) drives off
    // config.sources and calls register() twice, so the second surfaces PROVIDER_DUPLICATE_ID
    // at the single detection site. The map keeps last-wins; boot fails fast on that throw.
    stores.set(src.id, createSourceStore(src, { cacheDir, git }));
  }

  // Release the on-disk cache of any source removed from DeckConfig.sources[] (REQ-FRESH-05),
  // keeping every declared source's cache. Done synchronously so boot reconciliation is
  // deterministic before the scheduler starts polling.
  pruneOrphanCaches(cacheDir, new Set(stores.keys()));

  const reader = createSourceReader(stores);
  const runtime: SourcesRuntime = { cacheDir, sources: supported };
  return { runtime, stores, reader };
}

/** True for the two kinds this feature serves; every other kind is ignored (REQ-SRC-05). */
function isSupportedKind(src: Source): boolean {
  return (SOURCE_KINDS as readonly string[]).includes(src.kind);
}

/**
 * The on-disk cache root for acquired git trees (REQ-FRESH-05). Reads DECK_SOURCES_CACHE_DIR;
 * a blank/unset value falls back to a stable OS-temp subdirectory so a LOCAL-PATH-ONLY
 * deployment needs no configuration. Creates the dir (recursive) so first boot succeeds on a
 * clean host; a creation failure is fail-fast.
 */
function resolveCacheDir(env: NodeJS.ProcessEnv): string {
  const raw = env[SOURCES_ENV.CACHE_DIR]?.trim();
  const dir = raw && raw.length > 0 ? raw : join(tmpdir(), "deck-sources-cache");
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  } catch (cause) {
    throw configError(`${SOURCES_ENV.CACHE_DIR} directory could not be created.`, cause);
  }
  return dir;
}

/**
 * Remove every `<cacheDir>/<id>` subdirectory whose `<id>` is not currently declared — the
 * boot-time reconciliation that releases a removed source's cache (REQ-FRESH-05). Only ever
 * removes direct children of `cacheDir`; declared sources' caches are preserved. Best-effort:
 * a missing cache dir or an unremovable leftover is not fatal to boot.
 */
function pruneOrphanCaches(cacheDir: string, keep: ReadonlySet<string>): void {
  let entries: string[];
  try {
    entries = readdirSync(cacheDir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (keep.has(name)) continue;
    try {
      rmSync(join(cacheDir, name), { recursive: true, force: true });
    } catch {
      // best-effort: a leftover cache dir is not fatal.
    }
  }
}

function configError(message: string, cause?: unknown): Error & { code: string } {
  const error = new Error(
    message,
    cause === undefined ? undefined : { cause },
  ) as Error & { code: string };
  error.code = "SOURCES_CONFIG_INVALID";
  return error;
}
