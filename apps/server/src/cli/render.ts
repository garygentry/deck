import { writeFileSync } from "node:fs";
import { canonicalize } from "../config/canonical.js";
import { load, type ExitClass } from "../config/load.js";
import { manifestLoadOptions } from "../modules/runtime.js";
import { parseArgs } from "./args.js";
import { formatFindings, formatToolError } from "./findings-format.js";

/**
 * Render the document boot would serve, so it loads exactly as boot does (`boot: true`):
 * findings that only advise boot (a shared provider id, a refused credentialEnv) do not stop
 * it. `deck validate` still reports them as warnings.
 */
export function runRender(argv: readonly string[]): ExitClass {
  const { dir, out = "deck.config.json" } = parseArgs(argv);
  const runtime = runtimeOptions(dir);
  if ("toolError" in runtime) {
    process.stderr.write(`${runtime.toolError}\n`);
    return 2;
  }
  const result = load({ arg: dir, ...runtime, boot: true });

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

/** {@link runRender} as a string: the canonical document boot would serve. */
export function renderConfig(dir: string): string {
  const runtime = runtimeOptions(dir);
  if ("toolError" in runtime) throw new Error(runtime.toolError);
  const result = load({ arg: dir, ...runtime, boot: true });
  if (result.exitClass === 0) return canonicalize(result.config);
  const diagnostic = result.exitClass === 1
    ? formatFindings(result.findings)
    : formatToolError(result.toolError);
  throw new Error(diagnostic);
}

/** The runtime modules' load options, or the classified tool error for an unreadable DECK_MODULES_DIR. */
function runtimeOptions(dir: string | undefined): ReturnType<typeof manifestLoadOptions> | { toolError: string } {
  try {
    return manifestLoadOptions(dir);
  } catch (cause) {
    return { toolError: formatToolError({ code: "MODULES_DIR_UNREADABLE", message: (cause as Error).message }) };
  }
}
