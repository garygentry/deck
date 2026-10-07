import { composeConfig, type ComposedConfig, type ConfigContribution } from "./compose.js";

/**
 * Every built-in contribution not yet carried by a module manifest. Every built-in feature and
 * data source now is a module, so none remain.
 */
export const BUILTIN_CONTRIBUTIONS: readonly ConfigContribution[] = [];

let defaultComposition: ComposedConfig | undefined;

/** The kernel composed with {@link BUILTIN_CONTRIBUTIONS}: what deck validates without modules. */
export function composeDefault(): ComposedConfig {
  defaultComposition ??= composeConfig(BUILTIN_CONTRIBUTIONS);
  return defaultComposition;
}
