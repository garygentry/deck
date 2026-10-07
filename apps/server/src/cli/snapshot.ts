import { readFileSync } from "node:fs";
import { validateSnapshot } from "@deck/schema";
import type { ExitClass } from "../config/load.js";
import { formatFindings, formatToolError } from "./findings-format.js";

/**
 * `deck snapshot validate <file>` — validate a snapshot document against the
 * contract and report findings with the same exit-class scheme as `validate`
 * (0 clean / 1 findings / 2 tool error). A language-agnostic CI gate for
 * estate collectors: shell out and fail the build on a malformed snapshot.
 */
export function runSnapshotValidate(argv: readonly string[]): ExitClass {
  const file = argv.find((argument) => !argument.startsWith("-"));
  if (file === undefined) {
    process.stderr.write("usage: deck snapshot validate <file>\n");
    return 2;
  }

  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    process.stderr.write(
      `${formatToolError({ code: "SNAPSHOT_FILE_UNREADABLE", path: file, message: errorMessage(error) })}\n`,
    );
    return 2;
  }

  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch (error) {
    process.stderr.write(
      `${formatToolError({ code: "SNAPSHOT_JSON_PARSE", path: file, message: errorMessage(error) })}\n`,
    );
    return 2;
  }

  const result = validateSnapshot(document);

  if (result.classification === 2) {
    process.stderr.write(`${formatToolError(result.toolError)}\n`);
    return 2;
  }
  if (result.classification === 1) {
    process.stderr.write(`${formatFindings(result.findings)}\n`);
    return 1;
  }
  process.stdout.write(
    result.findings.length > 0
      ? `${formatFindings(result.findings)}\nclean (advisory only)\n`
      : "clean\n",
  );
  return 0;
}

/** Dispatch `deck snapshot <validate>`. */
export function runSnapshot(argv: readonly string[]): ExitClass {
  const [action, ...rest] = argv;
  if (action === "validate") return runSnapshotValidate(rest);
  process.stderr.write("usage: deck snapshot validate <file>\n");
  return 2;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
