import type { JsonObject, JsonPointer, JsonSchema, JsonValue } from "./json.js";

/**
 * A module manifest: everything the kernel needs to know about a module **without running
 * its code** — whether it is enabled, what config it owns, which provider kinds and UI
 * contributions it brings. It is plain JSON: built-ins write it in TypeScript, external
 * modules ship it as `deck-module.json`.
 */
export interface ModuleManifest {
  /** Module id, lowercase kebab-case (`llm-usage`). Its config lives at `modules.<id>`. */
  id: string;
  /** The module's own semver. */
  version: string;
  /** Range of the kernel module API this module was written against, e.g. `^0.1`. */
  deckApi: string;
  /** Module ids that must be enabled and initialised first. */
  dependsOn?: string[];
  /**
   * When the module is enabled. `config`: its `modules.<id>` section is present. `env`: the
   * named variable is `true` or `1` (case-insensitive). Every given condition must hold;
   * absent means always on.
   */
  enabledBy?: { config?: true; env?: string };
  /**
   * Environment variables the module owns and may read through `ctx.env`
   * (`^[A-Z][A-Z0-9_]*$`). A name is owned by one module: the host refuses a manifest that
   * declares a deployment setting the kernel reads (`DECK_DATA_DIR`, `DECK_PORT`, …) or a
   * name another module already owns (built-in modules claim first).
   */
  env?: string[];
  /**
   * Non-secret environment variables any module may read, and none owns (`TZ`,
   * `HTTPS_PROXY`). Never a kernel setting, never a name some module owns in `env`, and
   * never a credential: secrets belong in `env`, where they are the module's alone.
   */
  sharedEnv?: string[];
  /**
   * Pointers into the module's own config section whose string values name further readable
   * env vars (a config-named credential variable, for example). A resolved name must match
   * `^[A-Z][A-Z0-9_]*$`, and a deployment setting the kernel itself reads (`DECK_DATA_DIR`,
   * `DECK_SNAPSHOT_SOURCE`, …) is readable only when it is also listed in `env`.
   */
  envFromConfig?: JsonPointer[];
  config?: ModuleConfigDecl;
  providerKinds?: ProviderKindDecl[];
  /**
   * In-process services the module offers to, or reads from, other modules (see
   * `ServerModuleContext.services`). A module that `uses` a name initialises after every
   * running module that `provides` it.
   */
  services?: ModuleServicesDecl;
  contributes?: ModuleContributions;
  health?: ModuleHealthDecl;
  dataDir?: ModuleDataDirDecl;
}

export interface ModuleServicesDecl {
  /** Service names the module may offer, `<namespace>/<name>` (`sources/reader`). */
  provides?: string[];
  /** Service names the module may read. A name is never both provided and used by one module. */
  uses?: string[];
}

/** A service name: lowercase kebab-case segments joined by `/`, at least two. */
export const SERVICE_NAME_PATTERN = /^[a-z][a-z0-9-]*(?:\/[a-z][a-z0-9-]*)+$/;

export interface ModuleDataDirDecl {
  /**
   * A directory directly under `$DECK_DATA_DIR` that predates the module (`actions`), used
   * by `ctx.dataDir()` in place of `modules/<id>` so existing data stays where it is. One
   * literal segment, not `modules`, and unique across modules. Built-in modules only: on
   * any other module it makes the manifest invalid.
   */
  legacyPath: string;
}

export interface ModuleConfigDecl {
  /** JSON Schema fragment for the `modules.<id>` section. */
  schema: JsonSchema;
  /** Layer ownership of key paths, relative to the module section. */
  ownership?: Record<string, OwnerDecl>;
  /**
   * Identity fields for arrays, so layers merge their elements by identity rather than
   * position: relative key path → field names, or → `{ <type>: fields }` for an array of
   * items discriminated by a `type` field.
   */
  identity?: Record<string, string[] | Record<string, string[]>>;
  /**
   * Ids that must be unique, each entry one namespace that may span several arrays. A later
   * occurrence of a key already seen (in document order) is `ID_DUPLICATE`. An `identity` row
   * for an array a namespace covers only keys the layer merge; every other identity row is
   * checked for duplicates itself. When given, the list names at least one namespace.
   */
  unique?: UniqueDecl[];
  /** Finding codes this module's validation rules may emit. */
  findings?: FindingCodeDecl[];
  /**
   * Where the section names an estate host or service. The kernel resolves each one against
   * the estate, as it does its own references: `REF_HOST_UNRESOLVED` /
   * `REF_SERVICE_UNRESOLVED`, and in an overlay layer `OVERLAY_DANGLING_REF` against the base.
   */
  references?: ReferenceDecl[];
}

/**
 * A host/service reference in a module section. A string is a relative key path
 * (`actions[].target`) whose value is `{ host, service? }`, reported at the field that does
 * not resolve. The object form names the fields: `host` (default `"host"`) and `service`
 * (default `"service"`) are field names on the value at `path`, and `at: "element"` reports
 * a finding at the value itself rather than at the field. A value without a string host
 * field is not a reference and is skipped.
 */
export type ReferenceDecl =
  | string
  | { path: string; host?: string; service?: string; at?: "field" | "element" };

/** One id namespace: see {@link ModuleConfigDecl.unique}. */
export interface UniqueDecl {
  /**
   * Relative key paths of arrays, ending in `[]` (`groups[]`, `groups[].items[]`). Their
   * elements that carry every `key` field as an own property share the namespace; others are
   * skipped.
   */
  paths: string[];
  /** The fields whose values form the id. */
  key: string[];
  /**
   * The `ID_DUPLICATE` message; `{key}` is replaced by the id (a JSON string, or a
   * parenthesised tuple for a compound key). Default: a generic message.
   */
  message?: string;
}

export type OwnerDecl = "base" | "overlay" | "both" | "container";

export interface FindingCodeDecl {
  /** UPPER_SNAKE_CASE, unique across the kernel and every module. */
  code: string;
  severity: "error" | "warning" | "info";
  summary: string;
  fix: string;
}

export interface ProviderKindDecl {
  kind: string;
  /** Schema for one `integrations[]`/`sources[]` instance of this kind. */
  instanceSchema?: JsonSchema;
  /** Which top-level instance list `instanceSchema` applies to; default `integrations`. */
  instanceList?: "integrations" | "sources";
  /** Never polled: its data is fixed at registration (e.g. `link`). */
  static?: boolean;
  /**
   * May appear in `hosts[].bindings` / `services[].bindings`; the server module must then
   * handle it (`kinds[kind].binding`). A binding of a kind not bindable is reported.
   */
  bindable?: boolean;
  /** Its data can drive a status tone. */
  statusCapable?: boolean;
  /**
   * How a binding of this kind gives a bound card (a portal service) its up or down status:
   * declared data the web reads, so any `bindable`, `statusCapable` kind drives cards with no
   * feature code. Only such a kind may declare it.
   */
  status?: ProviderStatusDecl;
  /** Finding codes the kind handler's `validate` and `validateBinding` rules may report. */
  findings?: FindingCodeDecl[];
  /**
   * The fixed, public provider id the kind's `instances` handler registers under (offered with
   * `fixedId: true`), such as `prometheus`. Declared so config validation can tell another
   * instance taking it apart. Honoured for built-in modules only.
   */
  fixedId?: string;
  /**
   * With `fixedId`: the environment variable whose non-empty value registers the fixed id with
   * no instance in the estate (as `snapshot`'s `DECK_SNAPSHOT_SOURCE`). Config validation then
   * reserves the id while the variable is set. Honoured for built-in modules only.
   */
  fixedIdEnv?: string;
}

/**
 * Where a binding's status is in provider data, and which values mean up. The bound item is
 * read from the provider (`provider`); it is up when every `up` condition holds, else down. A
 * provider with no data, or none for the item, says so (unreachable, not found).
 */
export interface ProviderStatusDecl {
  /**
   * The provider a binding reads: `binding`, the one the kind's binding handler registers
   * under the binding's own id (one provider per binding, as `http-health`'s); `fixed`, the
   * kind's `fixedId` instance, shared by every binding (as `docker`'s).
   */
  provider: "binding" | "fixed";
  /**
   * The bound item: the element of the list at `list` (a key path of the data) whose `key`
   * field equals the binding's `binding` field (`{ list: "containers", key: "name", binding:
   * "container" }`). A binding without that field (text or a number) has no status from this
   * kind. Absent: the provider's data is the item.
   */
  match?: { list: string; key: string; binding: string };
  /** The item is up when every condition holds (its field's value is one of `in`), else down. */
  up: StatusConditionDecl[];
}

/** A condition on a bound item: the value at `field` (a key path) is one of `in`. */
export interface StatusConditionDecl {
  field: string;
  in: Array<string | number | boolean>;
}

/** An extension id: `<kind>:<module>/<name>`, e.g. `pill:llm-usage/summary`. */
export type ExtensionId = `${string}:${string}/${string}`;

export type Tone = "ok" | "warn" | "danger" | "info" | "pending" | "neutral";

export interface ModuleContributions {
  pages?: PageDecl[];
  nav?: NavDecl[];
  slots?: SlotDecl[];
  extensions?: ExtensionDecl[];
  widgetTypes?: WidgetTypeDecl[];
  statusMaps?: Record<string, StatusMapData>;
  /** Icon name → SVG markup (external modules; built-ins use the web icon registry). */
  icons?: Record<string, string>;
  routes?: RoutesDecl;
}

export interface PageDecl {
  id: ExtensionId;
  path: string;
  title: string;
  icon?: string;
  /** Export name in the module's web component table. */
  component: string;
  /**
   * The page's default dashboard: what its component renders, in reading order. The UI
   * manifest resolves it (each widget addressable by `widget:<module>/<page name>.<id>`, so
   * an override can switch it off), and the page renders it.
   */
  layout?: PageLayoutDecl;
}

/** A module page's dashboard: sections in reading order. */
export interface PageLayoutDecl {
  sections: PageSectionDecl[];
}

/**
 * One section of a module page's dashboard: the widgets a `widget` slot's extensions place
 * (`{ slot }`, a slot the module hosts), or widgets of the module's own types or core's.
 */
export type PageSectionDecl = { slot: string } | { widgets: PageWidgetDecl[] };

/**
 * A widget on a module page's dashboard. It reads no provider and takes no options: its
 * component brings its own data, and an operator's dashboard (`ui.pages`) places the type with
 * options and a source.
 */
export interface PageWidgetDecl {
  /** Unique on the page: the widget is `widget:<module>/<page name>.<id>`. */
  id: string;
  type: `${string}/${string}`;
}

export interface NavDecl {
  id: ExtensionId;
  /** Target page id, or an external/relative href. */
  page?: ExtensionId;
  href?: string;
  group: string;
  label?: string;
  icon?: string;
  order?: number;
}

export interface SlotDecl {
  id: string;
  accepts: "pill" | "widget" | "entity-section" | "nav" | "page" | "action";
}

export interface ExtensionDecl {
  id: ExtensionId;
  kind: string;
  attachTo: { slot: string; order?: number };
  component?: string;
  widget?: JsonObject;
  config?: JsonObject;
  enabled?: boolean;
}

export interface WidgetTypeDecl {
  /** `<module>/<widget>`. */
  type: `${string}/${string}`;
  optionsSchema: JsonSchema;
  component?: string;
  /** Provider kinds the widget can render. */
  sources?: string[];
  /**
   * Options whose values name entries of the module's own config section (not to be confused
   * with `config.references`, which resolve estate hosts and services): each value of
   * `option` (text, or a list of text) should be the `key` of an entry of `modules.<id>.<list>`.
   * One that is not is reported in the UI manifest (UI_WIDGET_OPTION_UNKNOWN); the widget
   * still renders, skipping it.
   */
  optionReferences?: WidgetOptionReferenceDecl[];
}

/** A widget option that names entries of its module's config section (`portal/groups`' `groups`). */
export interface WidgetOptionReferenceDecl {
  option: string;
  /** The list in the module's section (`groups`). */
  list: string;
  /** The key of its entries the option names (`id`). */
  key: string;
}

export interface StatusMapData {
  values?: Record<string, Tone>;
  rules?: StatusRule[];
}

export interface StatusRule {
  lt?: number;
  lte?: number;
  gt?: number;
  gte?: number;
  eq?: string | number | boolean;
  tone: Tone;
}

export interface RoutesDecl {
  /**
   * Extra prefixes the module's `/api/m/<id>` sub-app is also mounted at, for HTTP paths
   * that predate the module (e.g. `/api/llm-usage`). Literal paths under `/api/` only
   * (characters `A-Z a-z 0-9 . _ ~ - /`), outside `/api/m`, and not overlapping another
   * module's prefix or a kernel route.
   */
  legacyAliases?: string[];
  /**
   * Exact literal paths outside `/api` the module serves (e.g. `/metrics`). The SPA fallback
   * never rewrites them, even while the module is disabled.
   */
  rootPaths?: string[];
  /**
   * Fixed answers served at the module's prefixes (`/api/m/<id>` and every legacy alias)
   * while the module is installed but not running, so a client can still learn that the
   * capability is off. Without them those paths answer 404 like any unknown API path. No
   * module code runs for them.
   */
  whenDisabled?: DisabledRouteDecl[];
}

/** One fixed response a disabled module's prefixes answer. */
export interface DisabledRouteDecl {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /**
   * Path under the module's prefix: `""` for the prefix itself, else `/`-separated literal
   * or `:param` segments (`/runs/:runId/cancel`).
   */
  path: string;
  /** HTTP status, 200–599. */
  status: number;
  /** JSON response body. */
  body: JsonValue;
}

export interface ModuleHealthDecl {
  /**
   * A top-level `/api/health` key that mirrors this module's reported `data`, for health
   * fields that predate the module (e.g. `llmUsage`). It cannot shadow a kernel field.
   */
  legacyKey?: string;
}

/** Lowercase kebab-case module id. */
export const MODULE_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
