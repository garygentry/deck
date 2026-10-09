import { load, type ExitClass } from "../config/load.js";
import { manifestLoadOptions } from "../modules/runtime.js";
import { parseArgs } from "./args.js";
import { formatFindings, formatToolError } from "./findings-format.js";

export function runValidate(argv: readonly string[]): ExitClass {
  const { dir, advisoryDisabled } = parseArgs(argv);
  // A section for a module that is off where validation runs (an env flag unset in CI, say)
  // is checked as if the module were on, so CI fails what deck would fail once it is on.
  let runtime: ReturnType<typeof manifestLoadOptions>;
  try {
    runtime = manifestLoadOptions(dir);
  } catch (cause) {
    process.stderr.write(`${formatToolError({ code: "MODULES_DIR_UNREADABLE", message: (cause as Error).message })}\n`);
    return 2;
  }
  const result = load({ arg: dir, ...runtime, disabledSections: advisoryDisabled ? "advisory" : "strict" });

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
