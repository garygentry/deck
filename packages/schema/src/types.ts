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
  /**
   * The composed config contract to validate against; default: the kernel plus the
   * built-in contributions (`composeDefault()`).
   */
  composed?: ComposedConfig;
  /**
   * How sections of modules that are not enabled are checked: `advisory` (default) reports
   * their problems at info; `strict` at their real severity, as if the module were on. It
   * also sets the severity of PROVIDER_KIND_DISABLED (a kind only an off module provides).
   */
  disabledSections?: DisabledSections;
  /**
   * The environment deck runs with, for the checks that depend on it: a fixed provider id a
   * variable registers (`snapshot` while `DECK_SNAPSHOT_SOURCE` is set) is reserved
   * (PROVIDER_ID_RESERVED). Absent: no variable is set.
   */
  env?: Readonly<Record<string, string | undefined>>;
}

/** Per-severity counts in a validation result. */
export interface FindingSummary { error: number; warning: number; info: number }

/** Tool-error codes (classification 2). No partial findings accompany any of these. */
export type ToolErrorCode =
  | "INPUT_NOT_OBJECT"
  | "VERSION_UNREADABLE"
  | "CONFIG_UNSUPPORTED"
  | "CONFIG_MIGRATION_REQUIRED"
  | "INTERNAL";

import type { ComposedConfig, ConfigContribution, DisabledSections } from "./compose/compose.js";
import type { AnyFindingCode, Finding } from "./findings.js";

/** Validator result discriminated by exit classification. */
export type ValidationResult =
  | { classification: 0 | 1; findings: readonly Finding[]; summary: FindingSummary }
  | { classification: 2; findings: readonly []; toolError: { code: ToolErrorCode; message: string } };

/** A negative fixture expected to produce a particular finding. */
export interface InvalidFixture {
  name: string;
  layer: ValidateLayer | "snapshot";
  expect: AnyFindingCode;
  document: JsonObject;
  base?: JsonObject;
  config?: JsonObject;
  /**
   * Contributions an installed module would add, composed with the built-in ones to validate
   * this fixture (for a code no built-in contribution can trigger).
   */
  contributions?: readonly ConfigContribution[];
  /** Validate strictly or advisorily (default advisory), for a code whose severity depends on it. */
  disabledSections?: DisabledSections;
}

export type {
  DeckConfigDocument, Estate, Host, Service, Source, Integration, Bindings, Address, Access,
  Backup, SecretRef, ManagedConfig, Link, HostKind, HostStatus, ServiceKind, ServiceStatus, UiTheme,
  UiPage, UiPageNav, UiSection, UiWidget, UiStatusMap, UiStatusRule, UiTone,
} from "./types.config.generated.js";

export type {
  SnapshotDocument, ObservedHost, ObservedService, Collectors, Container, Guest,
  ObservedManagedConfig, DriftFinding, DriftLocation, Waiver, Coverage, ServiceState,
} from "./types.snapshot.generated.js";

export type {
  AnyFindingCode, Finding, FindingCode, FindingCodeEntry, ModuleHostFindingCode, Severity,
  ExitClassification,
} from "./findings.js";
export type {
  ComposedConfig, ComposedReference, ComposeOptions, ConfigContribution, ContributedFinding,
  ContributedProviderKind, ContributedReference, ContributedRule, ContributedUnique, ContributedWidgetType,
  DisabledSections,
} from "./compose/compose.js";
export type { IdentitySpec, Owner } from "./ownership.js";
