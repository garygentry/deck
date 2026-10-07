/**
 * The sources capability's one deployment setting, the on-disk cache root for acquired git
 * trees (`DECK_SOURCES_CACHE_DIR`). It is deck-deployment configuration, not estate config:
 * the `Source` contract carries no cache or timing knobs (CON-03). The `markdown-tree` and
 * `file-tree` modules read it to build their stores; the `sources` module creates it and
 * releases the caches of removed sources at init.
 */

import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Environment variable names for the sources capability (deck-deployment settings). */
export const SOURCES_ENV = {
  /** On-disk cache root for acquired git trees (REQ-FRESH-05). */
  CACHE_DIR: "DECK_SOURCES_CACHE_DIR",
} as const;

/**
 * The on-disk cache root for acquired git trees (REQ-FRESH-05): `DECK_SOURCES_CACHE_DIR`, or
 * when blank or unset a stable OS-temp subdirectory, so a local-path-only deployment needs no
 * configuration. Reads only; {@link ensureCacheDir} creates it.
 */
export function resolveCacheDir(env: { get(name: string): string | undefined }): string {
  const raw = env.get(SOURCES_ENV.CACHE_DIR)?.trim();
  return raw && raw.length > 0 ? raw : join(tmpdir(), "deck-sources-cache");
}

/**
 * Create the cache root (recursive) so first boot succeeds on a clean host.
 *
 * @throws {Error & { code: "SOURCES_CONFIG_INVALID" }} when it cannot be created; boot then
 * fails with exit class 2, so the server never runs a half-configured sources capability.
 */
export function ensureCacheDir(dir: string): void {
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  } catch (cause) {
    throw configError(`${SOURCES_ENV.CACHE_DIR} directory could not be created.`, cause);
  }
}

/**
 * Remove every `<cacheDir>/<id>` subdirectory whose `<id>` is not in `keep` — the boot-time
 * reconciliation that releases a removed source's cache (REQ-FRESH-05). Only ever removes
 * direct children of `cacheDir`; kept sources' caches are preserved. Best-effort: a missing
 * cache dir or an unremovable leftover is not fatal to boot.
 */
export function pruneOrphanCaches(cacheDir: string, keep: ReadonlySet<string>): void {
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
