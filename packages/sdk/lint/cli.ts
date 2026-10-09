#!/usr/bin/env node
/**
 * `deck-module`: tools for a runtime module's author.
 *
 *   deck-module lint [dir]   check a module directory (default: the current one) against
 *                            deck's UI guardrails; exits 1 when it finds an offence.
 *
 * A module's package.json may allowlist files that set an inline style (dynamic geometry only):
 * `"deckModule": { "lint": { "styleAllowlist": { "src/web/Gauge.tsx": "fill width from the value" } } }`.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { formatOffence, lintModule, type ModuleLintOptions } from "./index.ts";

const USAGE = "usage: deck-module lint [dir]";

/** The `deckModule.lint` options in the module's package.json, if any. */
function optionsOf(dir: string): ModuleLintOptions {
  const manifest = join(dir, "package.json");
  if (!existsSync(manifest)) return {};
  const lint = (JSON.parse(readFileSync(manifest, "utf8")) as { deckModule?: { lint?: ModuleLintOptions } }).deckModule?.lint;
  return { ...(lint?.styleAllowlist === undefined ? {} : { styleAllowlist: lint.styleAllowlist }) };
}

function main(argv: readonly string[]): number {
  const [command, target, ...rest] = argv;
  if (command === "--help" || command === "-h") {
    console.log(USAGE);
    return 0;
  }
  if (command !== "lint" || rest.length > 0) {
    console.error(USAGE);
    return 2;
  }
  const dir = resolve(target ?? ".");
  if (!existsSync(join(dir, "deck-module.json"))) {
    console.error(`deck-module lint: ${dir} has no deck-module.json`);
    return 2;
  }
  const offences = lintModule(dir, optionsOf(dir));
  for (const offence of offences) console.error(formatOffence(offence));
  if (offences.length > 0) {
    console.error(`deck-module lint: ${offences.length} offence${offences.length === 1 ? "" : "s"}`);
    return 1;
  }
  console.log("deck-module lint: no offences");
  return 0;
}

process.exitCode = main(process.argv.slice(2));
