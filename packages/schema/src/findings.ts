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
  PROVIDER_ID_SHARED: { severity: "warning", summary: "Two estate declarations in different collections, or two bindings, have the same provider id.", fix: "Give every integration, source and binding its own id; if both register a provider, deck cannot start." },
  REF_HOST_UNRESOLVED: { severity: "error", summary: "A host reference does not resolve to a declared host.", fix: "Point the reference to an existing host or declare the missing host." },
  REF_SERVICE_UNRESOLVED: { severity: "error", summary: "A service reference does not resolve to a declared service.", fix: "Point the reference to an existing service or declare the missing service." },
  LAYER_OVERLAY_KEY_IN_BASE: { severity: "warning", summary: "The base layer contains a property owned by the overlay.", fix: "Move the reported presentation property to the overlay layer." },
  LAYER_BASE_KEY_IN_OVERLAY: { severity: "error", summary: "The overlay layer contains a property owned by the base.", fix: "Move the reported inventory property to the base layer." },
  OVERLAY_DANGLING_REF: { severity: "error", summary: "An overlay reference cannot be resolved against the base layer.", fix: "Correct the reference or add its target to the base layer." },
  MODULE_UNKNOWN: { severity: "error", summary: "The modules section names a module this deck does not have.", fix: "Remove the section, or correct the module id to an installed module." },
  PROVIDER_BINDING_UNSUPPORTED: { severity: "info", summary: "A host or service binds a provider kind that does not accept bindings.", fix: "Remove the binding, or bind a kind whose module accepts host and service bindings." },
  PROVIDER_KIND_DISABLED: { severity: "warning", summary: "A provider kind is declared only by a module that is not running, so references to it are ignored.", fix: "Enable or fix the module that provides the kind, or remove the references to it." },
  PROVIDER_KIND_UNKNOWN: { severity: "warning", summary: "A provider kind is not in the known-kinds registry.", fix: "Use a known provider kind or register the additional kind for validation." },
  UI_WIDGET_TYPE_UNKNOWN: { severity: "warning", summary: "A widget names a type no module provides, so it renders as unavailable.", fix: "Use a widget type a module provides, or install the module that provides it." },
  UI_WIDGET_TYPE_DISABLED: { severity: "warning", summary: "A widget's type is provided only by a module that is not running, so it renders as unavailable.", fix: "Enable or fix the module that provides the widget type, or remove the widget." },
  UI_STATUS_MAP_UNKNOWN: { severity: "warning", summary: "A widget names a status map ui.statusMaps does not declare, so its values show without a tone.", fix: "Declare the status map under ui.statusMaps, or correct the name." },
  UI_EMBED_DISALLOWED: { severity: "info", summary: "A core/embed widget is configured while ui.allowUnsafeEmbeds is not true, so it shows that embeds are off.", fix: "Set ui.allowUnsafeEmbeds: true to show other sites' pages in frames, or remove the widget." },
  UI_EMBED_URL_INVALID: { severity: "error", summary: "A core/embed widget's url is not an http(s) URL with a valid host, or it carries user:password@.", fix: "Correct the url to an absolute http(s) URL the browser can parse, without credentials." },
  UI_WIDGET_SELECT_INVALID: { severity: "error", summary: "A widget's select is not a JMESPath expression.", fix: "Correct the expression at the reported path; see jmespath.org for the syntax." },
  SECRET_VALUE_SUSPECTED: { severity: "info", summary: "A value at a credential-related path resembles secret material.", fix: "Replace the value with a valid secret reference and keep secret material outside the document." },
  SNAPSHOT_HOST_DUPLICATE: { severity: "error", summary: "A snapshot contains the same observed host more than once.", fix: "Keep one observation for each host in the snapshot." },
  SNAPSHOT_SERVICE_DUPLICATE: { severity: "error", summary: "A snapshot contains the same observed service more than once.", fix: "Keep one observation for each service on a host." },
  DRIFT_ID_DUPLICATE: { severity: "error", summary: "A snapshot contains more than one drift finding with the same identifier.", fix: "Give every drift finding a unique identifier." },
  SNAPSHOT_HOST_UNDECLARED: { severity: "error", summary: "A snapshot host is absent from the configuration.", fix: "Declare the host in the configuration or remove its snapshot observation." },
  SNAPSHOT_SERVICE_UNDECLARED: { severity: "error", summary: "A snapshot service is absent from the configuration.", fix: "Declare the service in the configuration or remove its snapshot observation." },
  DRIFT_LOCATION_UNRESOLVED: { severity: "error", summary: "A drift finding points to a location absent from the configuration.", fix: "Correct the drift location so it resolves to a configured entity." },
  HOST_NOT_COLLECTED: { severity: "info", summary: "A configured host has no observation in the snapshot.", fix: "Collect the host or confirm that its absence is expected." },
} as const satisfies Record<string, { severity: Severity; summary: string; fix: string }>;

/**
 * Codes about modules rather than config values: the module host reports them while
 * planning modules from their manifests, and config validation reports MODULE_SECTION_DISABLED
 * and MODULE_RULE_FAILED for a module's section. They are catalogued here so every code deck can
 * print has one severity and one fix. Those two are `info`: a broken or disabled module is
 * reported and set aside (X2), never a reason to refuse the whole config.
 * MODULE_CREDENTIAL_ENV_REFUSED is reported by deck's config loading for an instance's
 * `credentialEnv`: at its severity by `deck validate`, and as `info` when deck boots.
 */
export const MODULE_HOST_FINDING_CATALOG = {
  MODULE_MANIFEST_INVALID: { severity: "warning", summary: "A module manifest is unusable, so the module is disabled.", fix: "Correct the manifest defect named in the message, or remove the module." },
  MODULE_MANIFEST_CONFLICT: { severity: "error", summary: "Two modules, or a module and the kernel, claim the same id, route, health key or config contribution.", fix: "Remove one of the conflicting modules or rename what they share." },
  MODULE_API_INCOMPATIBLE: { severity: "warning", summary: "A module requires a module API version this deck does not provide, so it is disabled.", fix: "Install a module release built for this deck's module API." },
  MODULE_DEPENDENCY_MISSING: { severity: "warning", summary: "A module depends on a module that is absent or disabled, so it is disabled.", fix: "Enable the module it depends on, or remove the dependent module." },
  MODULE_DEPENDENCY_CYCLE: { severity: "warning", summary: "A module is in, or depends on, a dependency cycle, so it is disabled.", fix: "Break the cycle in the modules' dependsOn lists." },
  MODULE_SECTION_DISABLED: { severity: "info", summary: "The config has a section for a module that is not enabled, so the section is ignored.", fix: "Enable the module, or remove its modules.<id> section." },
  MODULE_LOAD_FAILED: { severity: "warning", summary: "A runtime module in DECK_MODULES_DIR could not be loaded (unreadable manifest, integrity mismatch, or a server entry that failed to import), so it is disabled.", fix: "Fix or reinstall the module directory named in the message, update its integrity pin, or remove the module." },
  MODULE_KIND_HANDLER_FAILED: { severity: "warning", summary: "A module's provider-kind handler threw or returned something other than a list of offers, so the module is disabled.", fix: "Fix the module's kind handler, or remove the module." },
  MODULE_RULE_FAILED: { severity: "info", summary: "A module's config rule threw or reported an undeclared code, so the module is disabled.", fix: "Fix the module's config rule, or remove the module." },
  MODULE_CREDENTIAL_ENV_REFUSED: { severity: "warning", summary: "An instance's credentialEnv names a deck setting or another module's variable, which the module of its kind may not read.", fix: "Set the credential in a variable that is neither a deck setting nor another module's, and name that one." },
} as const satisfies Record<string, { severity: Severity; summary: string; fix: string }>;

/** A catalogued finding code: severity, one-line summary and fix. */
export interface FindingCodeEntry {
  severity: Severity;
  summary: string;
  fix: string;
}

/** A finding code the kernel validator emits. */
export type FindingCode = keyof typeof FINDING_CATALOG;

/** A finding code the module host emits. */
export type ModuleHostFindingCode = keyof typeof MODULE_HOST_FINDING_CATALOG;

/**
 * Any finding code: the kernel's, the module host's, or one a module declares in its
 * manifest. Module codes are open strings; the composed catalog knows them all.
 */
export type AnyFindingCode = FindingCode | ModuleHostFindingCode | (string & {});

export const FINDING_CODES = Object.keys(FINDING_CATALOG) as readonly FindingCode[];

export interface Finding {
  code: AnyFindingCode;
  severity: Severity;
  path: string;
  message: string;
  hint?: string;
  /**
   * The module a MODULE_RULE_FAILED finding is attributed to, when its path does not say (a
   * provider kind's instance rule reports at the instance, `/integrations/<i>`).
   */
  module?: string;
}

/** Build a finding with the catalogued severity for its code. */
export function finding(code: FindingCode, path: string, message: string, hint?: string): Finding {
  return { code, severity: FINDING_CATALOG[code].severity, path, message, ...(hint ? { hint } : {}) };
}

export type ExitClassification = 0 | 1 | 2;

export function classify(findings: readonly Finding[]): 0 | 1 {
  return findings.some((item) => item.severity !== "info") ? 1 : 0;
}
