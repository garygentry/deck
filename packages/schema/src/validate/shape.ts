import type { ErrorObject } from "ajv";
import type { ComposedConfig } from "../compose/compose.js";
import { finding, type Finding } from "../findings.js";
import type { ValidateLayer } from "../types.js";

function escapePointerSegment(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function childPath(parent: string, child: string): string {
  return `${parent}/${escapePointerSegment(child)}`;
}

export function mapAjvErrors(
  errors: ErrorObject[] | null | undefined,
  layer: ValidateLayer,
  composed?: ComposedConfig,
): Finding[] {
  // In the composed config schema an `if` only selects a provider kind's branch; that
  // branch's own errors say what is wrong, so the `if` error itself is noise.
  const relevant = (errors ?? []).filter((error) => composed === undefined || error.keyword !== "if");
  return relevant.map((error) => {
    if (error.keyword === "additionalProperties") {
      const property = String(error.params.additionalProperty);
      if (composed !== undefined && error.instancePath === "/modules") {
        const known = composed.knownModuleIds.length > 0 ? composed.knownModuleIds.join(", ") : "none";
        return finding(
          "MODULE_UNKNOWN",
          childPath(error.instancePath, property),
          `Module ${property} is not known to this deck (known modules: ${known}).`,
        );
      }
      return finding(
        "SCHEMA_UNKNOWN_PROPERTY",
        childPath(error.instancePath, property),
        `Property ${property} is not allowed in the closed ${layer} schema object.`,
      );
    }

    if (error.keyword === "required") {
      const property = String(error.params.missingProperty);
      return finding(
        "SCHEMA_REQUIRED_MISSING",
        childPath(error.instancePath, property),
        `Required property ${property} is missing from the ${layer} document.`,
      );
    }

    return finding(
      "SCHEMA_INVALID",
      error.instancePath,
      `${error.keyword}: ${error.message ?? "schema constraint failed"}.`,
    );
  });
}
