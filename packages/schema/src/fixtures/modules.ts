import { BUILTIN_CONTRIBUTIONS } from "../compose/builtin.js";
import { composeConfig, type ComposedConfig, type ConfigContribution } from "../compose/compose.js";
import { FIXTURE_DATA_SOURCES } from "./data-sources.js";

/**
 * Module sections the fixtures carry that this package does not compose, because a server
 * module owns their schema (`modules.actions`, `modules.portal`). Each stand-in accepts its
 * section as any object, so a fixture is checked for everything the kernel owns.
 */
export const FIXTURE_MODULE_STANDINS: readonly ConfigContribution[] = [
  { id: "actions", schema: { type: "object" } },
  { id: "portal", schema: { type: "object" } },
];

let composition: ComposedConfig | undefined;

/**
 * The kernel and built-in contributions plus {@link FIXTURE_MODULE_STANDINS} and the
 * data-source modules' kinds ({@link FIXTURE_DATA_SOURCES}): what the fixtures validate against.
 */
export function composeFixtures(): ComposedConfig {
  composition ??= composeConfig([...BUILTIN_CONTRIBUTIONS, ...FIXTURE_MODULE_STANDINS, FIXTURE_DATA_SOURCES]);
  return composition;
}
