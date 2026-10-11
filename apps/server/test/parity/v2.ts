/**
 * The declared v1 → v2 mapping the parity goldens are compared under. The goldens were
 * frozen from schemaVersion 1 estates; config v2 moves module settings under `modules`
 * (`llmUsage` → `modules.llm-usage`, `groups` → `modules.portal.groups`, `actions` →
 * `modules.actions.actions`) and changes nothing else a projection shows. So a frozen golden,
 * remapped here, must equal the capture of the same estate after `deck config migrate`.
 *
 * The remap touches only:
 * - an `/api/config` body: the document is moved to its v2 shape (`expectedV2`; a parity
 *   test also pins one migrated body to a hand-written literal, so the mapping is not only
 *   checked against itself);
 * - the finding lines of CLI outputs: JSON Pointers `/llmUsage…`, `/groups…`, `/actions…`
 *   gain their `/modules/<id>` prefix, and each validated layer's block is re-sorted the way
 *   the validator sorts v2 paths. Output order is otherwise compared exactly.
 */

import { readdirSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expectedV2, migrateLayer } from "../../src/config/migrate.js";

/** v1 root pointer → v2 pointer, for pointers inside a finding line. */
const POINTERS: ReadonlyArray<[RegExp, string]> = [
  [/(?<![\w>~.\-/])\/llmUsage(?=[/\s]|$)/g, "/modules/llm-usage"],
  [/(?<![\w>~.\-/])\/groups(?=[/\s]|$)/g, "/modules/portal/groups"],
  [/(?<![\w>~.\-/])\/actions(?=\/\d|\s|$)/g, "/modules/actions/actions"],
];

/** A `deck validate` finding line: `severity  path  CODE  message`. */
const FINDING_LINE = /^(error|warning|info)  (\S+)  ([A-Z][A-Z0-9_]*)  (.*)$/;

/**
 * Remap one frozen v1 golden to what the same estate projects as v2. Only two things change:
 * `/api/config` bodies (moved to their v2 shape), and the finding lines of CLI outputs (their
 * pointers remapped, then reordered as the validator orders v2 paths). Every other string,
 * such as a URL value that happens to contain `/groups`, must match exactly.
 */
export function remapV1Golden(golden: unknown, extra: ReadonlyArray<[string, string]> = []): unknown {
  return remapNode(golden, undefined, extra);
}

function remapNode(value: unknown, key: string | undefined, extra: ReadonlyArray<[string, string]>): unknown {
  if (Array.isArray(value)) return value.map((item) => remapNode(item, undefined, extra));
  if (value === null || typeof value !== "object") return value;
  const object = value as Record<string, unknown>;
  // An `/api/config` capture: `{ status, contentType, body }` under the `config` key.
  if (key === "config" && isObject(object.body) && object.body.schemaVersion === 1) {
    return { ...object, body: expectedV2(object.body) };
  }
  if (isCliProjection(object)) {
    return { ...object, stdout: remapOutput(object.stdout, extra), stderr: remapOutput(object.stderr, extra) };
  }
  return Object.fromEntries(Object.entries(object).map(([name, child]) => [name, remapNode(child, name, extra)]));
}

/**
 * Remap the finding lines of one CLI output. The validator prints one sorted block per
 * validated layer; each strictly ascending run of v1 lines is taken as one block, so after
 * remapping, each run is re-sorted by the v2 key the validator would use.
 */
function remapOutput(text: string, extra: ReadonlyArray<[string, string]>): string {
  const lines = text.split("\n");
  const output: string[] = [];
  let run: string[] = [];
  const flush = () => {
    output.push(...run.map((line) => remapLine(line, extra)).sort(compareFindingLines));
    run = [];
  };
  for (const line of lines) {
    if (!FINDING_LINE.test(line)) {
      flush();
      output.push(line);
      continue;
    }
    // A block is strictly ascending: a line that does not sort after the previous one (a
    // repeat included, as when base and merged report the same finding) starts the next block.
    if (run.length > 0 && compareFindingLines(run.at(-1)!, line) >= 0) flush();
    run.push(line);
  }
  flush();
  return output.join("\n");
}

function remapLine(line: string, extra: ReadonlyArray<[string, string]>): string {
  let text = line;
  for (const [pattern, replacement] of POINTERS) text = text.replace(pattern, replacement);
  for (const [from, to] of extra) text = text.replaceAll(from, to);
  return text;
}

/** The validator's order: path, then code, then message (code-unit comparison). */
export function compareFindingLines(a: string, b: string): number {
  const [, , pathA = "", codeA = "", messageA = ""] = FINDING_LINE.exec(a) ?? [];
  const [, , pathB = "", codeB = "", messageB = ""] = FINDING_LINE.exec(b) ?? [];
  const order = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);
  return order(pathA === "/" ? "" : pathA, pathB === "/" ? "" : pathB) || order(codeA, codeB) || order(messageA, messageB);
}

function isCliProjection(object: Record<string, unknown>): object is { exitClass: number; stdout: string; stderr: string } {
  return typeof object.exitClass === "number" && typeof object.stdout === "string" && typeof object.stderr === "string";
}

/**
 * Copy an estate's YAML layers into a temp dir and run `deck config migrate`'s per-layer
 * rewrite on each, leaving the committed (frozen v1) fixture untouched.
 */
export function migratedCopy(dir: string): { dir: string; cleanup(): void } {
  const copy = mkdtempSync(join(tmpdir(), "deck-parity-v2-"));
  for (const name of readdirSync(dir).filter((file) => /\.ya?ml$/i.test(file))) {
    const result = migrateLayer(readFileSync(join(dir, name), "utf8"));
    writeFileSync(join(copy, name), result.text);
  }
  return { dir: copy, cleanup: () => rmSync(copy, { recursive: true, force: true }) };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
