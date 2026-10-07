import type { ExitClass } from "../config/load.js";
import { parseArgs } from "./args.js";
import { runRender } from "./render.js";
import { runSnapshot } from "./snapshot.js";
import { runValidate } from "./validate.js";

export { parseArgs };

export function main(argv: readonly string[]): ExitClass {
  const [subcommand, ...rest] = argv;
  if (subcommand === "validate") return runValidate(rest);
  if (subcommand === "render") return runRender(rest);
  if (subcommand === "snapshot") return runSnapshot(rest);
  process.stderr.write(
    "usage: deck <validate|render|snapshot> [dir|file] [--config <dir>] [--out <file>]\n",
  );
  return 2;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
