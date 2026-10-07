import { finding, type Finding } from "../../findings.js";
import {
  CREDENTIAL_KEY_NAMES,
  SECRET_REF_PATTERN,
  TOKEN_PATTERNS,
} from "../../secrets.js";
import type { DeckConfigDocument } from "../../types.js";
import type { Context } from "../context.js";

const credentialKeys = new Set<string>(CREDENTIAL_KEY_NAMES);
const secretReference = new RegExp(SECRET_REF_PATTERN);

function escapePointerSegment(segment: string): string {
  return segment.replace(/~/g, "~0").replace(/\//g, "~1");
}

function normaliseKey(key: string): string {
  return key.toLowerCase().replace(/[-_]/g, "");
}

/** Walk every document value and report strings that resemble secret material. */
export function secrets(doc: DeckConfigDocument, _ctx: Context): Finding[] {
  const findings: Finding[] = [];

  const walk = (value: unknown, path: string, key?: string): void => {
    if (typeof value === "string") {
      if (key !== undefined && credentialKeys.has(normaliseKey(key)) && !secretReference.test(value)) {
        findings.push(
          finding(
            "SECRET_VALUE_SUSPECTED",
            path,
            `credential-named key '${key}' carries a value that is not a secret reference (length ${value.length})`,
          ),
        );
        return;
      }

      for (const token of TOKEN_PATTERNS) {
        if (token.pattern.test(value)) {
          findings.push(
            finding(
              "SECRET_VALUE_SUSPECTED",
              path,
              `value at ${path} matches the ${token.name} token shape (length ${value.length})`,
            ),
          );
          return;
        }
      }
      return;
    }

    if (Array.isArray(value)) {
      for (const [index, item] of value.entries()) {
        walk(item, `${path}/${index}`, String(index));
      }
      return;
    }

    if (value !== null && typeof value === "object") {
      for (const [childKey, child] of Object.entries(value)) {
        walk(child, `${path}/${escapePointerSegment(childKey)}`, childKey);
      }
    }
  };

  walk(doc, "");
  return findings;
}
