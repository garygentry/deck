import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A self-cleaning scratch cache dir for acquisition/cache tests. Sibling of
 * `tmp-config.ts`'s `makeConfigDir`; used as `DECK_SOURCES_CACHE_DIR` in unit + integration
 * tests so acquisition runs off-tree and self-cleans.
 */
export function makeCacheDir(): { dir: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), "deck-sources-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
