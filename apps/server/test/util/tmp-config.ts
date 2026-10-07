import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";

export function makeConfigDir(layers: Record<string, unknown>): { dir: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), "deck-cfg-"));
  for (const [name, document] of Object.entries(layers)) {
    writeFileSync(join(dir, name), stringify(document));
  }
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
