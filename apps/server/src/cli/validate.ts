import { load, type ExitClass } from "../config/load.js";
import { parseArgs } from "./args.js";
import { formatFindings, formatToolError } from "./findings-format.js";

export function runValidate(argv: readonly string[]): ExitClass {
  const { dir } = parseArgs(argv);
  const result = load({ arg: dir });

  if (result.exitClass === 0) {
    process.stdout.write(
      result.findings.length > 0
        ? `${formatFindings(result.findings)}\nclean (advisory only)\n`
        : "clean\n",
    );
    return 0;
  }
  if (result.exitClass === 1) {
    process.stderr.write(`${formatFindings(result.findings)}\n`);
    return 1;
  }
  process.stderr.write(`${formatToolError(result.toolError)}\n`);
  return 2;
}
