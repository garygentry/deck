// The JMESPath engine behind a widget's `select`. Server-only: it is reachable through the
// `@deck/schema/select` entry alone, so nothing that imports the main entry (the web bundle
// included) loads it.
import jmespath from "jmespath";

import type { JsonValue } from "./types.js";

/** Why `expression` is not a JMESPath expression (the parser's message), or `null`. */
export function selectProblem(expression: string): string | null {
  try {
    (jmespath as unknown as { compile(expression: string): unknown }).compile(expression);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** The outcome of one `select` over a provider's data. */
export type SelectResult = { value: JsonValue } | { error: string };

/**
 * Evaluate `expression` over `data`. The result is plain JSON: a value JSON cannot hold (the
 * engine reaches inherited properties such as `constructor`, which are functions) reads as
 * `null`. A runtime error (a function given the wrong arguments, say) is returned, never thrown.
 */
export function evaluateSelect(expression: string, data: unknown): SelectResult {
  let value: unknown;
  try {
    value = jmespath.search(data, expression);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  return { value: toJson(value) };
}

function toJson(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map(toJson);
  if (typeof value === "object" && value !== Object.prototype && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    const output: Record<string, JsonValue> = {};
    for (const [key, child] of Object.entries(value)) output[key] = toJson(child);
    return output;
  }
  // A function, an inherited prototype object, undefined: nothing JSON can carry.
  return null;
}
