// The JMESPath engine behind a widget's `select`. Server-only: it is reachable through the
// `@deck/schema/select` entry alone, so nothing that imports the main entry (the web bundle
// included) loads it. The engine is the vendored reference implementation
// (`select/jmespath.js`), whose field lookups read own properties only.
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
  /** Steps of one evaluation: every expression node visited, and every value a function is handed. */
  steps: 200_000,
  /** Values (scalars, lists and objects) in one result. */
  resultValues: 10_000,
  /** Nesting depth of one result. */
  resultDepth: 64,
  /** Bytes of one result, serialized as JSON. */
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

/** The outcome of one `select` over a provider's data. */
export type SelectResult = { value: JsonValue } | { error: string };

class SelectLimitError extends Error {}

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
  const charge = (cost: number): void => {
    steps += cost;
    if (steps > SELECT_LIMITS.steps) throw new SelectLimitError(`the select exceeded its work limit (${SELECT_LIMITS.steps} steps)`);
  };
  const runtime = new Runtime();
  const interpreter = new TreeInterpreter(runtime);
  runtime._interpreter = interpreter;
  const visit = TreeInterpreter.prototype.visit;
  interpreter.visit = function (node, value) {
    charge(1);
    return visit.call(this, node, value);
  };
  const callFunction = Runtime.prototype.callFunction;
  runtime.callFunction = function (name, resolvedArgs) {
    // A function's work grows with what it is handed: charge for each element and key.
    for (const arg of resolvedArgs) charge(Array.isArray(arg) ? arg.length : isPlainObject(arg) ? Object.keys(arg).length : 1);
    return callFunction.call(this, name, resolvedArgs);
  };
  // to_string serializes its argument: bounded like a result, never an unbounded stringify.
  const toString = runtime.functionTable.to_string!;
  runtime.functionTable.to_string = {
    ...toString,
    _func: ([value]) => (typeof value === "string" ? value : JSON.stringify(toBoundedJson(value))),
  };
  let value: unknown;
  try {
    value = interpreter.search(compiled.ast, data);
    const json = toBoundedJson(value);
    const bytes = JSON.stringify(json).length;
    if (bytes > SELECT_LIMITS.resultBytes) throw new SelectLimitError(`the result is larger than ${SELECT_LIMITS.resultBytes} bytes`);
    return { value: json };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * A value as plain JSON, within the result limits (throws {@link SelectLimitError} past
 * them): a value JSON cannot hold reads as `null`, and object keys are defined, never
 * assigned, so a `__proto__` key stays a key.
 */
function toBoundedJson(value: unknown): JsonValue {
  let values = 0;
  const convert = (current: unknown, depth: number): JsonValue => {
    values += 1;
    if (values > SELECT_LIMITS.resultValues) throw new SelectLimitError(`the result has more than ${SELECT_LIMITS.resultValues} values`);
    if (depth > SELECT_LIMITS.resultDepth) throw new SelectLimitError(`the result is nested deeper than ${SELECT_LIMITS.resultDepth} levels`);
    if (current === null || typeof current === "string" || typeof current === "boolean") return current;
    if (typeof current === "number") return Number.isFinite(current) ? current : null;
    if (Array.isArray(current)) return current.map((item) => convert(item, depth + 1));
    if (isPlainObject(current)) {
      const output: Record<string, JsonValue> = {};
      for (const key of Object.keys(current)) {
        Object.defineProperty(output, key, { value: convert(current[key], depth + 1), enumerable: true, writable: true, configurable: true });
      }
      return output;
    }
    // A function, an inherited prototype object, undefined: nothing JSON can carry.
    return null;
  };
  return convert(value, 0);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || value === Object.prototype) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isNode(value: unknown): value is JmesNode {
  return typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string";
}
