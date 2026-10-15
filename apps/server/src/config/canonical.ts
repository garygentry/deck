import { canonicalJson, type JsonValue } from "@deck/module-sdk";
import type { DeckConfig } from "../contract/config.js";

/** The rendered config as canonical JSON: sorted keys, two-space indent, trailing newline. */
export function canonicalize(config: DeckConfig): string {
  return canonicalJson(config as unknown as JsonValue);
}
