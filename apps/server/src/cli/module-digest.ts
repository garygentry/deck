import { statSync } from "node:fs";
import type { ExitClass } from "../config/load.js";
import { moduleDigest } from "../modules/runtime.js";

/**
 * `deck module digest <dir>`: print the integrity pin of a runtime module directory, the value
 * `moduleIntegrity.<id>` takes in the config.
 */
export function runModuleDigest(argv: readonly string[]): ExitClass {
  const dir = argv.find((argument) => !argument.startsWith("-"));
  if (dir === undefined) {
    process.stderr.write("usage: deck module digest <dir>\n");
    return 2;
  }
  try {
    if (!statSync(dir).isDirectory()) throw new Error("not a directory");
    process.stdout.write(`${moduleDigest(dir)}\n`);
    return 0;
  } catch (cause) {
    process.stderr.write(`MODULE_DIGEST_FAILED  ${dir}  ${(cause as Error).message}\n`);
    return 2;
  }
}
