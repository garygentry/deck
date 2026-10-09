import { CORE_WIDGET_TYPE_SCHEMAS } from "../core-widgets.js";
import type { JsonObject } from "../types.js";
import { composeConfig, type ComposedConfig, type ConfigContribution } from "./compose.js";

/**
 * Every built-in contribution not carried by a module manifest: the kernel's own widget types
 * (`core/…`). Every built-in feature and data source is a module.
 */
export const BUILTIN_CONTRIBUTIONS: readonly ConfigContribution[] = [
  { id: "core", widgetTypes: CORE_WIDGET_TYPE_SCHEMAS.map(({ type, optionsSchema }) => ({ type, optionsSchema: optionsSchema as unknown as JsonObject })) },
];

let defaultComposition: ComposedConfig | undefined;

/**
 * The kernel composed with {@link BUILTIN_CONTRIBUTIONS}. Browser-safe, so it does **not** check
 * widget `select` expressions (the engine is server-only): the server's entry,
 * `composeDefaultChecked()` / `composeChecked()` from `@deck/schema/select`, does.
 */
export function composeDefault(): ComposedConfig {
  defaultComposition ??= composeConfig(BUILTIN_CONTRIBUTIONS);
  return defaultComposition;
}
