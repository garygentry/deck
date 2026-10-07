import type { JsonValue } from "@deck/schema";
import type { DeckConfig } from "../contract/config.js";

export function canonicalize(config: DeckConfig): string {
  return `${JSON.stringify(sortKeys(config as unknown as JsonValue), null, 2)}\n`;
}

function sortKeys(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, JsonValue> = {};
    for (const key of Object.keys(value).sort()) sorted[key] = sortKeys(value[key]);
    return sorted;
  }
  return value;
}
