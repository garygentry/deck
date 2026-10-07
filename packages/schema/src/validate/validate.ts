import type {
  DeckConfigDocument,
  ValidateOptions,
  ValidationResult,
} from "../types.js";
import { checkConfig, checkOverlay } from "./ajv.js";
import { buildContext } from "./context.js";
import { build, toolError } from "./result.js";
import { identity } from "./rules/identity.js";
import { layers } from "./rules/layers.js";
import { llmUsage } from "./rules/llm-usage.js";
import { providerKinds } from "./rules/provider-kinds.js";
import { references } from "./rules/references.js";
import { secrets } from "./rules/secrets.js";
import { checkVersion } from "./rules/version.js";
import { mapAjvErrors } from "./shape.js";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validate an already-parsed config document. This function never throws. */
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

    const versionFinding = checkVersion(version as number);
    if (versionFinding) return build([versionFinding]);

    const layer = options?.layer ?? "merged";
    const check = layer === "overlay" ? checkOverlay : checkConfig;
    if (!check(document)) return build(mapAjvErrors(check.errors, layer));

    const doc = document as unknown as DeckConfigDocument;
    const context = buildContext(doc);

    return build([
      ...identity(doc, context),
      // An overlay's refs may target entities declared only in the base, so the
      // per-layer check would raise false REF_*_UNRESOLVED. Skip it ONLY when a
      // base is supplied — then danglingReferences (in layers) resolves overlay
      // refs against the base and the merged-doc pass is a backstop. With no
      // base to resolve against, fall back to the conservative per-layer check.
      ...(layer === "overlay" && isObject(options?.base) ? [] : references(doc, context)),
      ...layers(doc, context, layer, options?.base),
      ...providerKinds(doc, context, options?.knownKinds),
      ...secrets(doc, context),
      // Thresholds may be split across layers, so judge the merged document only.
      ...(layer === "merged" ? llmUsage(doc) : []),
    ]);
  } catch (error) {
    return toolError(
      "INTERNAL",
      error instanceof Error ? error.message : String(error),
    );
  }
}
