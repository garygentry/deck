// The JMESPath engine behind a widget's `select`. Server-only: it is reachable through the
// `@deck/schema/select` entry alone, so nothing that imports the main entry (the web bundle
// included) loads it. The engine is the vendored reference implementation
// (`select/jmespath.js`), whose field lookups read own properties only.
import { BUILTIN_CONTRIBUTIONS } from "./compose/builtin.js";
import { composeConfig, type ComposedConfig, type ConfigContribution } from "./compose/compose.js";
import { compile, Runtime, TreeInterpreter, type JmesNode } from "./select/jmespath.js";

import type { JsonValue } from "./types.js";

/**
 * What one `select` may cost, so no expression can stall the server. Static limits are
 * checked when the config is validated (UI_WIDGET_SELECT_INVALID); the others bound each
 * evaluation, and exceeding one makes that widget's projection an `{ error }`.
 */
export const SELECT_LIMITS = Object.freeze({
  /** Characters in an expression (also the schema's `maxLength`). */
  length: 1024,
  /** Nodes in the parsed expression. */
  nodes: 256,
  /** List and hash multi-selects (`[a, b]`, `{a: a}`), each of which can multiply the result. */
  multiSelects: 8,
  /**
   * Steps of one evaluation: one per expression node visited, plus, before anything is built,
   * the size of every list a slice, flatten or projection makes, every node an equality compares,
   * and each built-in function's input and output ({@link FUNCTION_COSTS}).
   */
  steps: 200_000,
  /** Characters the string-producing functions (join, reverse, to_string) may build in one evaluation. */
  stringChars: 256 * 1024,
  /** Values (scalars, lists and objects) in one result. */
  resultValues: 10_000,
  /** Nesting depth of one result. */
  resultDepth: 64,
  /** Bytes of one result, serialized as JSON and encoded as UTF-8. */
  resultBytes: 256 * 1024,
});

/** A parsed `select`, ready to evaluate any number of times; or why it cannot be. */
export type CompiledSelect =
  | { readonly expression: string; readonly ast: JmesNode; readonly problem?: undefined }
  | { readonly expression: string; readonly ast?: undefined; readonly problem: string };

/** The JMESPath functions and the argument counts they take: `[min, max]`. */
const FUNCTION_ARITY: ReadonlyMap<string, readonly [number, number]> = new Map(
  Object.entries(new Runtime().functionTable).map(([name, { _signature: signature }]) => {
    const variadic = signature[signature.length - 1]?.variadic === true;
    return [name, [signature.length, variadic ? Number.POSITIVE_INFINITY : signature.length]] as const;
  }),
);

/**
 * Parse a `select` and check it against the static limits and the function table (every
 * function exists and gets an argument count it takes). The result is evaluated with
 * {@link evaluateSelect}; one with a `problem` evaluates to that problem.
 */
export function compileSelect(expression: string): CompiledSelect {
  if (expression.length > SELECT_LIMITS.length) {
    return { expression, problem: `it is longer than ${SELECT_LIMITS.length} characters` };
  }
  let ast: JmesNode;
  try {
    ast = compile(expression);
  } catch (error) {
    return { expression, problem: error instanceof Error ? error.message : String(error) };
  }
  let nodes = 0;
  let multiSelects = 0;
  let problem: string | null = null;
  const walk = (node: JmesNode): void => {
    if (problem !== null) return;
    nodes += 1;
    if (node.type === "MultiSelectList" || node.type === "MultiSelectHash") multiSelects += 1;
    if (node.type === "Function") {
      const name = node.name ?? "";
      const arity = FUNCTION_ARITY.get(name);
      const count = node.children?.length ?? 0;
      if (arity === undefined) problem = `unknown function ${name}()`;
      else if (count < arity[0] || count > arity[1]) {
        const takes = arity[1] === Number.POSITIVE_INFINITY ? `at least ${arity[0]}` : String(arity[0]);
        problem = `${name}() takes ${takes} argument${arity[0] === 1 ? "" : "s"}, not ${count}`;
      }
    }
    for (const child of node.children ?? []) if (isNode(child)) walk(child);
    // A hash multi-select's pairs hold their expression in `value` (a literal's value is data).
    if (node.type === "KeyValuePair" && isNode(node.value)) walk(node.value);
  };
  walk(ast);
  if (problem !== null) return { expression, problem };
  if (nodes > SELECT_LIMITS.nodes) return { expression, problem: `it has ${nodes} parts; a select may have at most ${SELECT_LIMITS.nodes}` };
  if (multiSelects > SELECT_LIMITS.multiSelects) {
    return { expression, problem: `it has ${multiSelects} multi-selects ([…] or {…}); a select may have at most ${SELECT_LIMITS.multiSelects}` };
  }
  return { expression, ast };
}

/** Why `expression` is not a usable `select` (parse error, unknown function, wrong argument count, too large), or `null`. */
export function selectProblem(expression: string): string | null {
  return compileSelect(expression).problem ?? null;
}

/**
 * The server's composition: {@link composeConfig} with the `select` check always wired, so a
 * document validated against it reports UI_WIDGET_SELECT_INVALID. Deck composes only through
 * this (boot, `deck validate`, `ui` hot reload).
 */
export function composeChecked(contributions: readonly ConfigContribution[]): ComposedConfig {
  return composeConfig(contributions, { selectProblem });
}

let checkedDefault: ComposedConfig | undefined;

/** The library's default composition (the kernel and the built-in contributions), with the `select` check. */
export function composeDefaultChecked(): ComposedConfig {
  checkedDefault ??= composeChecked(BUILTIN_CONTRIBUTIONS);
  return checkedDefault;
}

/** The outcome of one `select` over a provider's data. */
export type SelectResult = { value: JsonValue } | { error: string };

class SelectLimitError extends Error {}

/** What a built-in function may cost: its work in steps, and the characters of a string it builds. */
interface FunctionCost {
  steps(args: readonly unknown[]): number;
  chars?(args: readonly unknown[]): number;
}

/**
 * Elements of a list, keys of an object, characters of a string; 1 for anything else. Counting
 * an object's keys enumerates them (O(keys)); the charge follows at once, so each enumeration is
 * paid for, and none repeats unpaid (an object's truthiness, which the engine tests repeatedly,
 * is enumerated and charged once per evaluation: Runtime#isEmptyObject).
 */
const sizeOf = (value: unknown): number =>
  Array.isArray(value) ? value.length : typeof value === "string" ? value.length : isPlainObject(value) ? Object.keys(value).length : 1;

/** Characters across the strings of a list (its other elements count 1). */
const charsOf = (value: unknown): number => (Array.isArray(value) ? value.reduce<number>((total, item) => total + (typeof item === "string" ? item.length : 1), 0) : sizeOf(value));

const sortCost = (value: unknown): number => {
  const n = sizeOf(value);
  return n * Math.max(1, Math.ceil(Math.log2(n + 1)));
};

/**
 * The closed audit of the engine's built-in functions: what each is charged, in steps, before
 * it runs (on top of one step per expression node, and the expression-reference functions'
 * own visits), and the characters a string-producing one builds. Every function in the engine's
 * table has a row (a test keeps it so); a function without one is refused.
 */
export const FUNCTION_COSTS: Readonly<Record<string, FunctionCost>> = Object.freeze({
  abs: { steps: () => 1 },
  avg: { steps: ([list]) => sizeOf(list) },
  ceil: { steps: () => 1 },
  contains: { steps: ([subject, search]) => sizeOf(subject) + sizeOf(search) },
  ends_with: { steps: ([subject, suffix]) => sizeOf(subject) + sizeOf(suffix) },
  floor: { steps: () => 1 },
  join: {
    steps: ([, list]) => sizeOf(list) + charsOf(list),
    chars: ([glue, list]) => charsOf(list) + sizeOf(glue) * Math.max(0, sizeOf(list) - 1),
  },
  keys: { steps: ([object]) => sizeOf(object) },
  length: { steps: ([subject]) => (isPlainObject(subject) ? sizeOf(subject) : 1) },
  map: { steps: ([, list]) => sizeOf(list) },
  max: { steps: ([list]) => sizeOf(list) + charsOf(list) },
  max_by: { steps: ([list]) => sizeOf(list) },
  merge: { steps: (objects) => objects.reduce<number>((total, object) => total + sizeOf(object), 0) },
  min: { steps: ([list]) => sizeOf(list) + charsOf(list) },
  min_by: { steps: ([list]) => sizeOf(list) },
  not_null: { steps: (values) => values.length },
  reverse: { steps: ([subject]) => sizeOf(subject), chars: ([subject]) => (typeof subject === "string" ? subject.length : 0) },
  sort: { steps: ([list]) => sortCost(list) + charsOf(list) },
  sort_by: { steps: ([list]) => sortCost(list) },
  starts_with: { steps: ([subject, prefix]) => sizeOf(subject) + sizeOf(prefix) },
  sum: { steps: ([list]) => sizeOf(list) },
  to_array: { steps: () => 1 },
  to_number: { steps: ([value]) => sizeOf(value) },
  // Serialized through toBoundedJson, which charges each value and counts the characters it would build.
  to_string: { steps: () => 1 },
  type: { steps: () => 1 },
  values: { steps: ([object]) => sizeOf(object) },
});

/**
 * Evaluate a select (compiled, or an expression to compile) over `data`. Never throws: a
 * runtime error (a function given the wrong type, say), a select with a problem, or one that
 * exceeds {@link SELECT_LIMITS} is returned as `{ error }`. The value is plain JSON, written
 * so that no key (`__proto__` included) can change an object's prototype.
 */
export function evaluateSelect(select: CompiledSelect | string, data: unknown): SelectResult {
  const compiled = typeof select === "string" ? compileSelect(select) : select;
  if (compiled.problem !== undefined) return { error: compiled.problem };
  let steps = 0;
  let chars = 0;
  const charge = (cost: number): void => {
    steps += cost;
    if (steps > SELECT_LIMITS.steps) throw new SelectLimitError(`the select exceeded its work limit (${SELECT_LIMITS.steps} steps)`);
  };
  const build = (length: number): void => {
    chars += length;
    if (chars > SELECT_LIMITS.stringChars) throw new SelectLimitError(`the select built more than ${SELECT_LIMITS.stringChars} characters of text`);
  };
  const runtime = new Runtime();
  const interpreter = new TreeInterpreter(runtime);
  runtime._interpreter = interpreter;
  runtime.charge = charge;
  const visit = TreeInterpreter.prototype.visit;
  interpreter.visit = function (node, value) {
    charge(1);
    return visit.call(this, node, value);
  };
  const callFunction = Runtime.prototype.callFunction;
  runtime.callFunction = function (name, resolvedArgs) {
    const cost = FUNCTION_COSTS[name];
    if (cost === undefined) throw new Error(`unknown function ${name}()`);
    // Any text it would build counted, and its work charged, before it runs (or checks its arguments).
    if (cost.chars !== undefined) build(cost.chars(resolvedArgs));
    charge(cost.steps(resolvedArgs));
    return callFunction.call(this, name, resolvedArgs);
  };
  // to_string serializes its argument within the result limits, never an unbounded stringify.
  const toString = runtime.functionTable.to_string!;
  runtime.functionTable.to_string = {
    ...toString,
    _func: ([value]) => {
      if (typeof value === "string") return value;
      const json = toBoundedJson(value, charge);
      build(json.chars);
      return JSON.stringify(json.value);
    },
  };
  try {
    const { value } = toBoundedJson(interpreter.search(compiled.ast, data), charge);
    const bytes = utf8Length(JSON.stringify(value));
    if (bytes > SELECT_LIMITS.resultBytes) throw new SelectLimitError(`the result is larger than ${SELECT_LIMITS.resultBytes} bytes`);
    return { value };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * A value as plain JSON, within the result limits (throws {@link SelectLimitError} past them),
 * with the characters its serialization holds at least (strings and keys, before escapes): a
 * value JSON cannot hold reads as `null`, and object keys are defined, never assigned, so a
 * `__proto__` key stays a key. Each value is charged one step.
 */
function toBoundedJson(value: unknown, charge: (cost: number) => void): { value: JsonValue; chars: number } {
  let values = 0;
  let chars = 0;
  const text = (length: number): void => {
    chars += length;
    if (chars > SELECT_LIMITS.resultBytes) throw new SelectLimitError(`the result is larger than ${SELECT_LIMITS.resultBytes} bytes`);
  };
  const convert = (current: unknown, depth: number): JsonValue => {
    values += 1;
    charge(1);
    if (values > SELECT_LIMITS.resultValues) throw new SelectLimitError(`the result has more than ${SELECT_LIMITS.resultValues} values`);
    if (depth > SELECT_LIMITS.resultDepth) throw new SelectLimitError(`the result is nested deeper than ${SELECT_LIMITS.resultDepth} levels`);
    if (typeof current === "string") {
      text(current.length);
      return current;
    }
    if (current === null || typeof current === "boolean") return current;
    if (typeof current === "number") return Number.isFinite(current) ? current : null;
    if (Array.isArray(current)) return current.map((item) => convert(item, depth + 1));
    if (isPlainObject(current)) {
      const output: Record<string, JsonValue> = {};
      for (const key of Object.keys(current)) {
        text(key.length);
        Object.defineProperty(output, key, { value: convert(current[key], depth + 1), enumerable: true, writable: true, configurable: true });
      }
      return output;
    }
    // A function, an expression reference, an inherited prototype object, undefined: nothing JSON can carry.
    return null;
  };
  const converted = convert(value, 0);
  return { value: converted, chars };
}

/** The UTF-8 byte length of a string (JSON.stringify leaves no lone surrogates). */
export function utf8Length(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
      // A surrogate pair: one code point of four bytes.
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  return bytes;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || value === Object.prototype) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isNode(value: unknown): value is JmesNode {
  return typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string";
}
