import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Create a throwaway DECK_DATA_DIR (mirrors makeConfigDir in tmp-config.ts). */
export function makeDataDir(): { dir: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), "deck-data-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
