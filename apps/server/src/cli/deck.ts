import type { ExitClass } from "../config/load.js";
import { parseArgs } from "./args.js";
import { runConfigMigrate } from "./migrate.js";
import { runModuleDigest } from "./module-digest.js";
import { runRender } from "./render.js";
import { runSnapshot } from "./snapshot.js";
import { runValidate } from "./validate.js";

export { parseArgs };

export function main(argv: readonly string[]): ExitClass {
  const [subcommand, ...rest] = argv;
  if (subcommand === "validate") return runValidate(rest);
  if (subcommand === "render") return runRender(rest);
  if (subcommand === "snapshot") return runSnapshot(rest);
  if (subcommand === "config" && rest[0] === "migrate") return runConfigMigrate(rest.slice(1));
  if (subcommand === "module" && rest[0] === "digest") return runModuleDigest(rest.slice(1));
  process.stderr.write(
    "usage: deck <validate|render|snapshot> [dir|file] [--config <dir>] [--out <file>] [--advisory-disabled]\n" +
      "       deck config migrate <dir> [--dry-run]\n" +
      "       deck module digest <dir>\n",
  );
  return 2;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
