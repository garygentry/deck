import { ErrorState } from "@/ui";

/** What a value is, in a word, for a message about the wrong kind of value. */
function kindOf(value: unknown): string {
  if (value === null || value === undefined) return "no value (does it read a source?)";
  if (Array.isArray(value)) return "a list";
  if (typeof value === "object") return "an object";
  return typeof value === "string" ? "text" : `a ${typeof value}`;
}

/**
 * A widget given a value its type cannot show (an object for `core/stat`, say): a compact error
 * naming what it shows and what it got, so the `select` can be corrected.
 */
export function UnexpectedValue({ type, expected, value }: { type: string; expected: string; value: unknown }) {
  return <ErrorState compact title="Unexpected data" message={`${type} shows ${expected}; this widget's value is ${kindOf(value)}.`} />;
}
