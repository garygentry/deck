import { composeDefault } from "../compose/builtin.js";
import type {
  DeckConfigDocument,
  JsonObject,
  ValidateOptions,
  ValidationResult,
} from "../types.js";
import { MIGRATABLE_CONFIG_VERSION, supportedConfigVersions } from "../version.js";
import { buildContext } from "./context.js";
import { build, toolError } from "./result.js";
import { identity, providerIdSharing } from "./rules/identity.js";
import { layers } from "./rules/layers.js";
import { providerKinds } from "./rules/provider-kinds.js";
import { references } from "./rules/references.js";
import { secrets } from "./rules/secrets.js";
import { uiWidgets } from "./rules/ui-widgets.js";
import { checkVersion } from "./rules/version.js";
import { mapAjvErrors } from "./shape.js";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate an already-parsed config document against the composed config contract
 * (`options.composed`, default: the kernel plus the built-in contributions). This
 * function never throws. Widget `select` expressions are checked only when the composition
 * carries the check: compose with `composeChecked()` from the server-only `@deck/schema/select`
 * (as deck does); the default composition does not check them.
 */
export function validate(
  document: unknown,
  options?: ValidateOptions,
): ValidationResult {
  try {
    if (!isObject(document)) {
      return toolError("INPUT_NOT_OBJECT", "document is not an object");
    }

    const version = document.schemaVersion;
    if (!Number.isInteger(version)) {
      return toolError("VERSION_UNREADABLE", "schemaVersion is not an integer");
    }
    if (version === MIGRATABLE_CONFIG_VERSION) {
      return toolError(
        "CONFIG_MIGRATION_REQUIRED",
        `schemaVersion ${version} config is no longer accepted; run \`deck config migrate <config dir>\` to rewrite it as schemaVersion ${[...supportedConfigVersions].join(", ")}`,
      );
    }

    const versionFinding = checkVersion(version as number, supportedConfigVersions);
    if (versionFinding) return build([versionFinding]);

    const composed = options?.composed ?? composeDefault();
    const layer = options?.layer ?? "merged";
    const check = layer === "overlay" ? composed.checkOverlay : composed.checkConfig;
    if (!check(document)) return build(mapAjvErrors(check.errors, layer, composed));

    const doc = document as unknown as DeckConfigDocument;
    const strict = options?.disabledSections === "strict";
    const context = buildContext(doc);

    const kernelIdentity = identity(doc, context);
    return build([
      ...kernelIdentity,
      // A layer alone lacks the ids its bindings inherit from earlier layers.
      ...(layer === "merged" ? providerIdSharing(doc) : []),
      // An overlay's refs may target entities declared only in the base, so the
      // per-layer check would raise false REF_*_UNRESOLVED. Skip it ONLY when a
      // base is supplied — then danglingReferences (in layers) resolves overlay
      // refs against the base and the merged-doc pass is a backstop. With no
      // base to resolve against, fall back to the conservative per-layer check.
      ...(layer === "overlay" && isObject(options?.base) ? [] : references(doc, context, composed.references)),
      ...layers(doc, composed, layer, options?.base, strict),
      ...providerKinds(doc, composed, strict),
      ...uiWidgets(doc, composed, strict, layer),
      ...secrets(doc, context),
      // Module array identities: a duplicate the kernel rules already report is not repeated.
      ...composed.runChecks(document as JsonObject, layer, { disabledSections: strict ? "strict" : "advisory" }).filter(
        (item) => item.code !== "ID_DUPLICATE" || !kernelIdentity.some((other) => other.code === item.code && other.path === item.path),
      ),
    ]);
  } catch (error) {
    return toolError(
      "INTERNAL",
      error instanceof Error ? error.message : String(error),
    );
  }
}
