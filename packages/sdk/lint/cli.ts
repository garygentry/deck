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

import { builtWebJs, formatOffence, lintModule, type ModuleLintOptions } from "./index.ts";

const USAGE = "usage: deck-module lint [dir]";

class UsageError extends Error {}

/** The `deckModule.lint` options in the module's package.json, if any. */
function optionsOf(dir: string): ModuleLintOptions {
  const manifest = join(dir, "package.json");
  if (!existsSync(manifest)) return {};
  let lint: unknown;
  try {
    lint = (JSON.parse(readFileSync(manifest, "utf8")) as { deckModule?: { lint?: unknown } } | null)?.deckModule?.lint;
  } catch (error) {
    throw new UsageError(`${manifest} is not valid JSON: ${(error as Error).message}`);
  }
  if (lint === undefined) return {};
  const allowlist = (lint as { styleAllowlist?: unknown } | null)?.styleAllowlist;
  if (allowlist === undefined) return {};
  if (typeof allowlist !== "object" || allowlist === null || Array.isArray(allowlist) || !Object.values(allowlist).every((why) => typeof why === "string")) {
    throw new UsageError(`${manifest}: deckModule.lint.styleAllowlist must map file paths to the reason each may set an inline style`);
  }
  return { styleAllowlist: allowlist as Record<string, string> };
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
  let options: ModuleLintOptions;
  try {
    options = optionsOf(dir);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    console.error(`deck-module lint: ${error.message}`);
    return 2;
  }
  const offences = lintModule(dir, options);
  if (existsSync(join(dir, "src")) && builtWebJs(dir) === undefined) {
    console.log("deck-module lint: no built web.js found (web.js or dist/<id>/web.js): build the module to check what deck will serve");
  }
  for (const offence of offences) console.error(formatOffence(offence));
  if (offences.length > 0) {
    console.error(`deck-module lint: ${offences.length} offence${offences.length === 1 ? "" : "s"}`);
    return 1;
  }
  console.log("deck-module lint: no offences");
  return 0;
}

process.exitCode = main(process.argv.slice(2));
