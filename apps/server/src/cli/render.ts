import { writeFileSync } from "node:fs";
import { canonicalize } from "../config/canonical.js";
import { load, type ExitClass } from "../config/load.js";
import { parseArgs } from "./args.js";
import { formatFindings, formatToolError } from "./findings-format.js";

export function runRender(argv: readonly string[]): ExitClass {
  const { dir, out = "deck.config.json" } = parseArgs(argv);
  const result = load({ arg: dir });

  if (result.exitClass !== 0) {
    const diagnostic = result.exitClass === 1
      ? formatFindings(result.findings)
      : formatToolError(result.toolError);
    process.stderr.write(`${diagnostic}\n`);
    return result.exitClass;
  }

  writeFileSync(out, canonicalize(result.config), "utf8");
  return 0;
}

export function renderConfig(dir: string): string {
  const result = load({ arg: dir });
  if (result.exitClass === 0) return canonicalize(result.config);
  const diagnostic = result.exitClass === 1
    ? formatFindings(result.findings)
    : formatToolError(result.toolError);
  throw new Error(diagnostic);
}
