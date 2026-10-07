import type { ErrorObject } from "ajv";
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
): Finding[] {
  return (errors ?? []).map((error) => {
    if (error.keyword === "additionalProperties") {
      const property = String(error.params.additionalProperty);
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
