import { isDeepStrictEqual } from "node:util";

import { CONFIG_SCHEMA_VERSION, MIGRATABLE_CONFIG_VERSION } from "@deck/schema";
import { isMap, isNode, isScalar, LineCounter, parse, parseDocument, type Pair, type Scalar } from "yaml";

/** A v1 root key and where it moves to under `modules` in v2. */
interface Move {
  from: string;
  /** Module id: the key under `modules`. */
  module: string;
  /** Key inside the module section, or undefined when the value becomes the section. */
  key?: string;
}

const MOVES: readonly Move[] = [
  { from: "llmUsage", module: "llm-usage" },
  { from: "groups", module: "portal", key: "groups" },
  { from: "actions", module: "actions", key: "actions" },
];

/** A layer file `deck config migrate` cannot rewrite; nothing is written when one occurs. */
export class MigrateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrateError";
  }
}

export interface MigrateResult {
  /** `migrated`: `text` is the v2 rewrite. `current`: already v2, `text` is the input. */
  status: "migrated" | "current";
  text: string;
  warnings: string[];
}

/**
 * One root key's lines: `lead` holds the blank and comment lines above it (a comment banner
 * belongs to the key it introduces), `body` the key line and its value.
 */
interface Block {
  key: string;
  lead: string[];
  body: string[];
}

const BY_HAND = "migrate this file by hand";

/**
 * Rewrite one config layer file from schemaVersion 1 to 2:
 * - `llmUsage` → `modules.llm-usage`, `groups` → `modules.portal.groups`, `actions` →
 *   `modules.actions.actions`;
 * - `agents` is dropped (with a warning when it has entries); its comments are kept;
 * - `schemaVersion` becomes 2.
 *
 * Keys stay in the file they are in, so each layer keeps what it owns. The rewrite moves
 * source lines, re-indented, rather than re-rendering YAML, so comments, quoting, flow
 * styles and line endings are kept. The result is checked against the expected data;
 * anything the line surgery cannot carry (an alias it would separate from its anchor, for
 * example) is a {@link MigrateError}. A v2 file is returned unchanged.
 */
export function migrateLayer(text: string): MigrateResult {
  const lineCounter = new LineCounter();
  let input: Record<string, unknown>;
  let keyLines: Array<{ key: string; line: number }>;
  let agentsComment: string | undefined;
  try {
    const doc = parseDocument(text, { lineCounter });
    if (doc.errors.length > 0) throw new MigrateError(`not valid YAML: ${doc.errors[0]!.message}`);
    const root = doc.contents;
    if (!isMap(root)) throw new MigrateError("the document is not a mapping");
    input = doc.toJS() as Record<string, unknown>;
    if (input.schemaVersion === CONFIG_SCHEMA_VERSION) return { status: "current", text, warnings: [] };
    if (input.schemaVersion !== MIGRATABLE_CONFIG_VERSION) {
      throw new MigrateError(
        `schemaVersion is ${JSON.stringify(input.schemaVersion ?? null)}; only schemaVersion ${MIGRATABLE_CONFIG_VERSION} can be migrated`,
      );
    }
    if (root.flow) throw new MigrateError("the root mapping is in flow style; rewrite it in block style first");
    if ("modules" in input) throw new MigrateError("a schemaVersion 1 document cannot already have `modules`");
    keyLines = root.items.map((pair) => {
      if (!isScalar(pair.key) || pair.key.range === undefined) throw new MigrateError("a root key is not a plain scalar");
      return { key: String(pair.key.value), line: lineCounter.linePos(pair.key.range[0]).line - 1 };
    });
    const agents = root.items.find((pair) => isScalar(pair.key) && pair.key.value === "agents");
    if (agents !== undefined) agentsComment = keyLineComment(text, agents);
  } catch (error) {
    if (error instanceof MigrateError) throw error;
    throw new MigrateError(`cannot read the document (${(error as Error).message}); ${BY_HAND}`);
  }

  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/(?<=\n)/);
  if (lines.length > 0 && !lines.at(-1)!.endsWith("\n")) lines[lines.length - 1] += eol;
  const isLead = (line: string) => line.trim() === "" || line.startsWith("#");
  // Trailing blank lines, comments and a `...` end marker stay at the end of the file.
  let footerStart = lines.length;
  while (footerStart > keyLines.at(-1)!.line + 1 && (isLead(lines[footerStart - 1]!) || /^\.\.\.\s*$/.test(lines[footerStart - 1]!))) {
    footerStart -= 1;
  }
  const leadStart = (line: number) => {
    let start = line;
    while (start > 0 && isLead(lines[start - 1]!)) start -= 1;
    return start;
  };
  const header = lines.slice(0, leadStart(keyLines[0]!.line));
  const blocks: Block[] = keyLines.map(({ key, line }, index) => {
    const next = keyLines[index + 1];
    return {
      key,
      lead: lines.slice(leadStart(line), line),
      body: lines.slice(line, next === undefined ? footerStart : leadStart(next.line)),
    };
  });
  const footer = lines.slice(footerStart);

  const warnings: string[] = [];
  const agents = input.agents;
  if ("agents" in input && (!Array.isArray(agents) || agents.length > 0)) {
    warnings.push("dropped `agents`: the reserved section is gone in schemaVersion 2 and its entries were never used");
  }
  const expected = expectedV2(input);
  const movedAt = blocks.map((block, index) => (MOVES.some(({ from }) => from === block.key) ? index : -1)).filter((index) => index >= 0);
  // The `modules` section goes where the first moved key was. If that would put an alias
  // before its anchor, the last moved key's place may still work.
  const placements = [...new Set([movedAt[0] ?? -1, movedAt.at(-1) ?? -1])];
  let lastProblem = "";
  for (const placement of placements) {
    const migrated = [header, ...render(blocks, placement, eol, agentsComment), footer].flat().join("");
    let actual: unknown;
    try {
      actual = parse(migrated);
    } catch (error) {
      lastProblem = (error as Error).message;
      continue;
    }
    if (isDeepStrictEqual(actual, expected)) return { status: "migrated", text: migrated, warnings };
    lastProblem = "the rewritten document does not match the expected data";
  }
  throw new MigrateError(`the rewrite does not round-trip (${lastProblem}); ${BY_HAND}`);
}

/** Lay the blocks out as v2, with the `modules` section at block index `placement`. */
function render(blocks: readonly Block[], placement: number, eol: string, agentsComment: string | undefined): string[][] {
  const output: string[][] = [];
  const sections = new Map<string, string[]>();
  let modulesLead: string[] = [];
  for (const [index, block] of blocks.entries()) {
    if (block.key === "schemaVersion") {
      output.push(block.lead, block.body.map((line) => line.replace(/^schemaVersion:(\s*)1\b/, `schemaVersion:$1${CONFIG_SCHEMA_VERSION}`)));
    } else if (block.key === "agents") {
      // The value goes; its comments stay, including one on the key line.
      output.push(block.lead, [
        ...(agentsComment === undefined ? [] : [`${agentsComment}${eol}`]),
        ...block.body.slice(1).filter((line) => line.trimStart().startsWith("#")),
      ]);
    } else {
      const move = MOVES.find(({ from }) => from === block.key);
      if (move === undefined) {
        output.push(block.lead, block.body);
      } else {
        // Blank lines above the first moved key separate the new section; comments move with their key.
        const blank = block.lead.findIndex((line) => line.trim() !== "");
        const spacing = blank === -1 ? block.lead : block.lead.slice(0, blank);
        const comments = blank === -1 ? [] : block.lead.slice(blank);
        const section = sections.get(move.module) ?? [];
        sections.set(move.module, section);
        if (sections.size === 1 && section.length === 0) modulesLead = spacing;
        else section.push(...spacing);
        if (move.key === undefined) {
          section.push(...indent([...comments, ...renameKey(block.body, move.from, move.module)], 2));
        } else {
          if (section.length === 0 || !section.some((line) => line.startsWith(`  ${move.module}:`))) section.push(`  ${move.module}:${eol}`);
          section.push(...indent([...comments, ...renameKey(block.body, move.from, move.key)], 4));
        }
      }
    }
    if (index === placement) output.push(MODULES_SLOT);
  }
  const slot = output.indexOf(MODULES_SLOT);
  if (slot !== -1) output[slot] = [...modulesLead, `modules:${eol}`, ...[...sections.values()].flat()];
  return output;
}

/**
 * The comment at the end of a root pair's key line, located by the parser's source offsets
 * (after the key, and after the value when the value ends on that line), so a `#` inside a
 * quoted value is never mistaken for one.
 */
function keyLineComment(text: string, pair: Pair): string | undefined {
  const key = pair.key as Scalar;
  const lineEnd = (() => {
    const end = text.indexOf("\n", key.range![0]);
    return end === -1 ? text.length : end;
  })();
  const value = isNode(pair.value) ? pair.value.range ?? undefined : undefined;
  const from = value !== undefined && value[1] <= lineEnd ? Math.max(value[1], key.range![1]) : key.range![1];
  const match = /(?:^|[\s:])(#.*)$/.exec(text.slice(from, lineEnd).replace(/\r$/, ""));
  return match?.[1];
}

/** Marks where the `modules` section is laid out once every moved block is collected. */
const MODULES_SLOT: string[] = [];

/** The v2 document a v1 document migrates to, as data. */
export function expectedV2(v1: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  const modules: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(v1)) {
    if (key === "agents") continue;
    const move = MOVES.find(({ from }) => from === key);
    if (move === undefined) {
      output[key] = key === "schemaVersion" ? CONFIG_SCHEMA_VERSION : value;
      continue;
    }
    if (!("modules" in output)) output.modules = modules;
    if (move.key === undefined) modules[move.module] = value;
    else modules[move.module] = { ...(modules[move.module] as object | undefined), [move.key]: value };
  }
  return output;
}

function renameKey(lines: string[], from: string, to: string): string[] {
  if (from === to) return lines;
  const keyLine = lines.findIndex((line) => line.startsWith(`${from}:`));
  return lines.map((line, index) => (index === keyLine ? `${to}${line.slice(from.length)}` : line));
}

function indent(lines: string[], width: number): string[] {
  const pad = " ".repeat(width);
  return lines.map((line) => (line.trim() === "" ? line : `${pad}${line}`));
}
