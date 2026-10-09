import type { StatusMapData, StatusRule, Tone } from "./manifest.js";

/** The tones a status map may give, in the shell's vocabulary. */
export const STATUS_TONES: readonly Tone[] = ["ok", "warn", "danger", "info", "pending", "neutral"];

/** Whether a value is one of the six tones. */
export function isTone(value: unknown): value is Tone {
  return typeof value === "string" && (STATUS_TONES as readonly string[]).includes(value);
}

/**
 * A value's tone under a status map (`ui.statusMaps`), or `undefined` when the map gives it
 * none (the widget shows it untoned):
 * - its entry in `values`, when the value is text, a number or a boolean whose text is a key
 *   there (`404`, `true` and `"running"` all compare as text);
 * - else the first rule whose every condition holds, in order: `lt`/`lte`/`gt`/`gte` hold for a
 *   number, or text that reads wholly as one (`" 42 "` does not), and `eq` for an equal value,
 *   either way round: as numbers when either side is a number and both read as one (`0` and
 *   `"0.0"`), else as text (`true` and `"true"`); a rule with no condition matches any value.
 * Read leniently: a malformed map or rule (config validation refuses them) matches nothing.
 */
export function statusTone(map: StatusMapData | undefined, value: unknown): Tone | undefined {
  if (map === undefined || map === null || typeof map !== "object") return undefined;
  const text = scalarText(value);
  const values = map.values;
  if (text !== undefined && values !== null && typeof values === "object" && Object.hasOwn(values, text)) {
    const tone = values[text];
    if (isTone(tone)) return tone;
  }
  if (!Array.isArray(map.rules)) return undefined;
  const number = numberOf(value);
  for (const rule of map.rules) {
    if (rule !== null && typeof rule === "object" && isTone(rule.tone) && ruleHolds(rule, value, number)) return rule.tone;
  }
  return undefined;
}

function ruleHolds(rule: StatusRule, value: unknown, number: number | undefined): boolean {
  const bounds: Array<[number | undefined, (n: number, bound: number) => boolean]> = [
    [rule.lt, (n, bound) => n < bound],
    [rule.lte, (n, bound) => n <= bound],
    [rule.gt, (n, bound) => n > bound],
    [rule.gte, (n, bound) => n >= bound],
  ];
  for (const [bound, holds] of bounds) {
    if (bound === undefined) continue;
    if (typeof bound !== "number" || number === undefined || !holds(number, bound)) return false;
  }
  if (rule.eq !== undefined && !equals(rule.eq, value)) return false;
  return true;
}

/**
 * `eq`, symmetric: when either side is a number and both read as numbers, they compare as
 * numbers (`0` equals `"0.0"`, `100` equals `"1e2"`, `"404"` equals `404`); otherwise as text,
 * as `values` keys do (`true` equals `"true"`).
 */
function equals(expected: unknown, value: unknown): boolean {
  if (typeof expected === "number" || typeof value === "number") {
    const a = numberOf(expected);
    const b = numberOf(value);
    if (a !== undefined && b !== undefined) return a === b;
  }
  const text = scalarText(value);
  return text !== undefined && scalarText(expected) === text;
}

/** A value as text, for a `values` key: text, a finite number or a boolean. */
function scalarText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : undefined;
  if (typeof value === "boolean") return String(value);
  return undefined;
}

const NUMERIC_TEXT = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/;

/** A finite number, or text that reads wholly as one; else `undefined`. */
export function numberOf(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string" && NUMERIC_TEXT.test(value)) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}
