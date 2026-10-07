/** A JSON scalar. */
export type JsonPrimitive = string | number | boolean | null;
/** Any JSON value: scalar, array, or object. */
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;
/** A JSON object with string keys and JSON values. */
export type JsonObject = { [key: string]: JsonValue };

/** A config document belongs to one of two authored layers. */
export type Layer = "base" | "overlay";
/** What `validate` may be told a document is; "merged" disables the ownership rule. */
export type ValidateLayer = Layer | "merged";

/** Options for validating an already-parsed document. */
export interface ValidateOptions {
  /** Which layer the document is; default "merged" (ownership rule off). */
  layer?: ValidateLayer;
  /** Base layer used for overlay reference checks. */
  base?: unknown;
  /** Additional provider kinds accepted for this call. */
  knownKinds?: readonly string[];
}

/** Per-severity counts in a validation result. */
export interface FindingSummary { error: number; warning: number; info: number }

/** Tool-error codes (classification 2). No partial findings accompany any of these. */
export type ToolErrorCode =
  | "INPUT_NOT_OBJECT"
  | "VERSION_UNREADABLE"
  | "CONFIG_UNSUPPORTED"
  | "INTERNAL";

import type { Finding, FindingCode } from "./findings.js";

/** Validator result discriminated by exit classification. */
export type ValidationResult =
  | { classification: 0 | 1; findings: readonly Finding[]; summary: FindingSummary }
  | { classification: 2; findings: readonly []; toolError: { code: ToolErrorCode; message: string } };

/** A negative fixture expected to produce a particular finding. */
export interface InvalidFixture {
  name: string;
  layer: ValidateLayer | "snapshot";
  expect: FindingCode;
  document: JsonObject;
  base?: JsonObject;
  config?: JsonObject;
}

export type {
  DeckConfigDocument, Estate, Host, Service, Group, GroupItem, ServiceItem, LinkItem,
  Subgroup, Source, Integration, Action, ActionParam, Agent, Bindings, Address, Access,
  Backup, SecretRef, ManagedConfig, Link, HostKind, HostStatus, ServiceKind, ServiceStatus,
} from "./types.config.generated.js";

export type {
  SnapshotDocument, ObservedHost, ObservedService, Collectors, Container, Guest,
  ObservedManagedConfig, DriftFinding, DriftLocation, Waiver, Coverage, ServiceState,
} from "./types.snapshot.generated.js";

export type { Finding, FindingCode, Severity, ExitClassification } from "./findings.js";
