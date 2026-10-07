/**
 * The registry of provider kinds the validator recognises. Provider `kind` is an
 * OPEN string in the schema (REQ-SCHEMA-13) — this registry is the library-level
 * check: a binding or integration kind outside this set ∪ options.knownKinds yields
 * a PROVIDER_KIND_UNKNOWN warning (REQ-VAL-09). Callers extend it by PASSING
 * `knownKinds`, never by mutating this array (it is `as const`).
 */
export const KNOWN_PROVIDER_KINDS = [
  "link", "docker", "gatus", "prometheus", "alertmanager", "snapshot", "markdown-tree", "file-tree", "http-health",
] as const;
