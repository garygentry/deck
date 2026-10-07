import type { Severity } from "./types.snapshot.generated.js";

export type { Severity };

export const FINDING_CATALOG = {
  VERSION_UNSUPPORTED: { severity: "error", summary: "The document uses an unsupported schema version.", fix: "Change the document to a schema version supported by this library." },
  SCHEMA_INVALID: { severity: "error", summary: "The document does not match the required schema shape.", fix: "Correct the value at the reported path to match the schema." },
  SCHEMA_UNKNOWN_PROPERTY: { severity: "error", summary: "The document contains a property that the schema does not allow.", fix: "Remove the unknown property or move its data to a supported field." },
  SCHEMA_REQUIRED_MISSING: { severity: "error", summary: "The document is missing a required property.", fix: "Add the required property at the reported path." },
  HOST_DUPLICATE: { severity: "error", summary: "More than one host has the same identity.", fix: "Give every host a unique name." },
  SERVICE_DUPLICATE: { severity: "error", summary: "More than one service has the same identity on a host.", fix: "Give every service on the host a unique name." },
  ID_DUPLICATE: { severity: "error", summary: "An identifier is used more than once where it must be unique.", fix: "Replace the duplicate identifier with a unique value." },
  REF_HOST_UNRESOLVED: { severity: "error", summary: "A host reference does not resolve to a declared host.", fix: "Point the reference to an existing host or declare the missing host." },
  REF_SERVICE_UNRESOLVED: { severity: "error", summary: "A service reference does not resolve to a declared service.", fix: "Point the reference to an existing service or declare the missing service." },
  LAYER_OVERLAY_KEY_IN_BASE: { severity: "warning", summary: "The base layer contains a property owned by the overlay.", fix: "Move the reported presentation property to the overlay layer." },
  LAYER_BASE_KEY_IN_OVERLAY: { severity: "error", summary: "The overlay layer contains a property owned by the base.", fix: "Move the reported inventory property to the base layer." },
  OVERLAY_DANGLING_REF: { severity: "error", summary: "An overlay reference cannot be resolved against the base layer.", fix: "Correct the reference or add its target to the base layer." },
  PROVIDER_KIND_UNKNOWN: { severity: "warning", summary: "A provider kind is not in the known-kinds registry.", fix: "Use a known provider kind or register the additional kind for validation." },
  SECRET_VALUE_SUSPECTED: { severity: "info", summary: "A value at a credential-related path resembles secret material.", fix: "Replace the value with a valid secret reference and keep secret material outside the document." },
  SNAPSHOT_HOST_DUPLICATE: { severity: "error", summary: "A snapshot contains the same observed host more than once.", fix: "Keep one observation for each host in the snapshot." },
  SNAPSHOT_SERVICE_DUPLICATE: { severity: "error", summary: "A snapshot contains the same observed service more than once.", fix: "Keep one observation for each service on a host." },
  DRIFT_ID_DUPLICATE: { severity: "error", summary: "A snapshot contains more than one drift finding with the same identifier.", fix: "Give every drift finding a unique identifier." },
  SNAPSHOT_HOST_UNDECLARED: { severity: "error", summary: "A snapshot host is absent from the configuration.", fix: "Declare the host in the configuration or remove its snapshot observation." },
  SNAPSHOT_SERVICE_UNDECLARED: { severity: "error", summary: "A snapshot service is absent from the configuration.", fix: "Declare the service in the configuration or remove its snapshot observation." },
  DRIFT_LOCATION_UNRESOLVED: { severity: "error", summary: "A drift finding points to a location absent from the configuration.", fix: "Correct the drift location so it resolves to a configured entity." },
  LLM_USAGE_INVALID: { severity: "error", summary: "The llmUsage section has values deck cannot run with.", fix: "Use positive ISO-8601 durations and keep thresholds.warn at or below thresholds.danger." },
  HOST_NOT_COLLECTED: { severity: "info", summary: "A configured host has no observation in the snapshot.", fix: "Collect the host or confirm that its absence is expected." },
} as const satisfies Record<string, { severity: Severity; summary: string; fix: string }>;

export type FindingCode = keyof typeof FINDING_CATALOG;

export const FINDING_CODES = Object.keys(FINDING_CATALOG) as readonly FindingCode[];

export interface Finding {
  code: FindingCode;
  severity: Severity;
  path: string;
  message: string;
  hint?: string;
}

/** Build a finding with the catalogued severity for its code. */
export function finding(code: FindingCode, path: string, message: string, hint?: string): Finding {
  return { code, severity: FINDING_CATALOG[code].severity, path, message, ...(hint ? { hint } : {}) };
}

export type ExitClassification = 0 | 1 | 2;

export function classify(findings: readonly Finding[]): 0 | 1 {
  return findings.some((item) => item.severity !== "info") ? 1 : 0;
}
