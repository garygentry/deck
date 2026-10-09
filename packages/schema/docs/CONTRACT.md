# `@deck/schema` contract

This is the human-facing contract for deck config documents (schema version 2) and snapshot documents (schema version 1).

## Schema files & consumption

The stable schema files are `schema/deck.schema.json` (exported as `@deck/schema/deck.schema.json`) and `schema/snapshot.schema.json` (exported as `@deck/schema/snapshot.schema.json`). Both are standalone JSON Schema draft 2020-12 documents. A projector can vendor a pinned checkout and validate its output with a conforming JSON Schema implementation in any language.

`deck.schema.json` holds the kernel keys only: `schemaVersion`, `estate`, `hosts`, `services`, `sources`, `integrations`, `ui` and `modules`. Module settings live under `modules.<id>`, and each module contributes the schema of its own section. This library carries no module sections: each module (deck's `portal`, `llm-usage` and `actions` server modules among them) contributes its section, ownership rows, identity rows, id namespaces, host/service references, rules and finding codes through `composeConfig`, so they are not listed here. The config deck validates is the kernel schema composed with every module's section: `composeConfig(contributions)` builds it, and `composeDefault()` is the composition with the built-in contributions alone (the provider kinds of the built-in data sources), which has no module sections. Both the root and `modules` are closed, so a key or module id deck does not know is rejected. The generated `DeckConfigDocument` types `modules` as an open map; each module types its own section.

The package's `.` and `./fixtures` entry points export TypeScript source. Bare `node` cannot import those library entry points without a transpiling toolchain. The JSON schema files do not have that restriction and are the interface intended for non-TypeScript consumers.

## Layering: base + overlay

A generated base holds inventory intent. A hand-authored overlay holds presentation and integration data. They combine by identity, never array position. Objects deep-merge; overlay-owned conflicts take the overlay value and base-owned conflicts keep the base value. An overlay may add but cannot delete; use the overlay-owned `hidden` flag to hide an entity.

`both` means either layer may contain the key. `container` means merge recurses and ownership is determined by descendants. A deeper key without an explicit row inherits its nearest ancestor's owner.

### Per-key ownership

| Key path | Owning layer |
|---|---|
| `schemaVersion` | `both` |
| `estate` | `container` |
| `hosts` | `container` |
| `services` | `container` |
| `estate.name` | `base` |
| `estate.domains` | `base` |
| `estate.timezone` | `base` |
| `estate.freshness` | `overlay` |
| `hosts[].name` | `base` |
| `hosts[].kind` | `base` |
| `hosts[].purpose` | `base` |
| `hosts[].hypervisor` | `base` |
| `hosts[].vmid` | `base` |
| `hosts[].addresses` | `base` |
| `hosts[].access` | `base` |
| `hosts[].backup` | `base` |
| `hosts[].managedConfigs` | `base` |
| `hosts[].stacksRoot` | `base` |
| `hosts[].secrets` | `base` |
| `hosts[].links` | `overlay` |
| `hosts[].bindings` | `overlay` |
| `hosts[].hidden` | `overlay` |
| `services[].name` | `base` |
| `services[].host` | `base` |
| `services[].kind` | `base` |
| `services[].purpose` | `base` |
| `services[].status` | `base` |
| `services[].stack` | `base` |
| `services[].secrets` | `base` |
| `services[].backup` | `base` |
| `services[].links` | `overlay` |
| `services[].bindings` | `overlay` |
| `services[].hidden` | `overlay` |
| `sources` | `overlay` |
| `integrations` | `overlay` |
| `ui` | `overlay` |
| `modules` | `container` |

A module declares the ownership of keys in its section relative to the section; a section without a row of its own is overlay-owned. The rows of a server module's section (`modules.portal`, `modules.actions`, `modules.llm-usage`) come with that module, not this library.

### Identity rules

Identity-keyed arrays pair elements using these fields. Identity values must be unique. A module's identity rows are checked for duplicates the same way, except where one of the module's id namespaces (`unique`, which may span several arrays) covers the array: there the namespace decides what must be unique, and the identity row only pairs elements for the merge.

| Collection | Identity definition |
|---|---|
| `hosts` | `["name"]` |
| `services` | `["host","name"]` |
| `hosts[].links` | `["href"]` |
| `services[].links` | `["href"]` |
| `sources` | `["id"]` |
| `integrations` | `["id"]` |
| `ui.nav.groups` | `["id"]` |
| `ui.nav.items` | `["id"]` |
| `ui.pages` | `["id"]` |

## Recommended loader call order

```ts
const b = validate(base, { layer: "base" });
const o = validate(overlay, { layer: "overlay", base });
if (b.classification === 2 || o.classification === 2) { /* exit 2 */ }
const merged = merge(base, overlay);
const m = validate(merged);
const s = validateSnapshot(snapshot, merged);
// process exit = max(b, o, m, s).classification
```

Each call takes an optional composed contract (`{ composed }` for `validate`, a third argument for `merge`); the default is `composeDefault()`. Deck passes the composition of its installed modules. Validators accept already-parsed objects, perform no I/O, and never throw. Passing `base` when validating an overlay is mandatory: it is how `OVERLAY_DANGLING_REF` is detected before merge. `merge` can throw `MergeError` for non-object input, version mismatch, or a missing identity; callers map that failure to exit classification 2.

## The finding model

A `Finding` has a stable machine-readable `code`, a `severity`, an RFC 6901 JSON Pointer `path` (`""` is the root), a human-readable `message`, and an optional `hint`. The shared severity vocabulary is `error | warning | info`.

Exit classification is: `0` when there are no errors or warnings (info is allowed), `1` when any warning or error exists, and `2` for a tool error such as unreadable input/version, a schemaVersion 1 config (`CONFIG_MIGRATION_REQUIRED`), or an internal failure. Tool errors carry no findings. `classify(findings)` returns only `0 | 1`; classification 2 is a separate arm of `ValidationResult`.

## Two-tier consumer model

Tier 1 travels in the draft-2020-12 JSON schemas and is enforced by conforming validators: object shape and `additionalProperties`, `required`, `enum` and `const`, `pattern`, `format: date-time`, `dependentRequired`, and `if`/`then`.

Tier 2 is enforced only by the library: identity uniqueness, referential integrity, layer ownership and dangling overlay references, unknown provider kinds, secret heuristics, and snapshot/config cross-checks. A non-TypeScript consumer using only the JSON schemas receives shape checks, not these semantic checks.

## Finding codes

Each code has a fixed severity. Trigger describes when it is emitted; Fix gives the corrective action. Modules add their own codes, each declared in the module's manifest with a severity, summary and fix; the composed catalog holds them all, and two declarations of one code cannot be composed.

### Schema-level codes

| Code | Severity | Trigger | Fix |
|---|---|---|---|
| `VERSION_UNSUPPORTED` | `error` | The document uses an unsupported integer schema version. | Change the document to a schema version supported by this library. |
| `SCHEMA_INVALID` | `error` | A value does not match the required schema shape. | Correct the value at the reported path to match the schema. |
| `SCHEMA_UNKNOWN_PROPERTY` | `error` | A closed object contains an undeclared property. | Remove the unknown property or move its data to a supported field. |
| `SCHEMA_REQUIRED_MISSING` | `error` | A required property is absent. | Add the required property at the reported path. |
| `MODULE_UNKNOWN` | `error` | `modules` has a section for a module id this deck does not have. | Remove the section, or correct the module id to an installed module. |

### Library-only semantic rules

| Code | Severity | Trigger | Fix |
|---|---|---|---|
| `HOST_DUPLICATE` | `error` | More than one host has the same name. | Give every host a unique name. |
| `SERVICE_DUPLICATE` | `error` | More than one service has the same host/name identity. | Give every service on the host a unique name. |
| `ID_DUPLICATE` | `error` | An id is repeated where it must be unique. | Replace the duplicate identifier with a unique value. |
| `PROVIDER_ID_SHARED` | `warning` | In the merged document, an integration, source or host/service binding uses a provider id another collection (or another binding) already uses. A binding's id is its own `id`, else `<kind>:<owner>`. A warning, not an error: validation cannot tell which declarations register a provider, and two that do still fail boot with `PROVIDER_DUPLICATE_ID`. Deck's boot reports it as `info`. | Give every integration, source and binding its own id. |
| `REF_HOST_UNRESOLVED` | `error` | A host reference has no declared target. | Point the reference to an existing host or declare the missing host. |
| `REF_SERVICE_UNRESOLVED` | `error` | A service reference has no declared target. | Point the reference to an existing service or declare the missing service. |
| `LAYER_OVERLAY_KEY_IN_BASE` | `warning` | The base contains an overlay-owned property. | Move the reported presentation property to the overlay layer. |
| `LAYER_BASE_KEY_IN_OVERLAY` | `error` | The overlay contains a base-owned property. | Move the reported inventory property to the base layer. |
| `OVERLAY_DANGLING_REF` | `error` | An overlay reference does not resolve against the base. | Correct the reference or add its target to the base layer. |
| `PROVIDER_BINDING_UNSUPPORTED` | `info` | A host or service binds a declared provider kind that does not accept bindings; the binding is ignored. | Remove the binding, or bind a kind whose module accepts host and service bindings. |
| `PROVIDER_KIND_DISABLED` | `warning` | A binding or integration uses a provider kind declared only by a module that is not running; the reference is ignored. Reported at `info` unless validation is strict (`disabledSections: "strict"`, as `deck validate` runs). | Enable or fix the module that provides the kind, or remove the references to it. |
| `PROVIDER_KIND_UNKNOWN` | `warning` | A provider kind is not declared by any composed contribution. | Use a known provider kind or register the additional kind for validation. |
| `UI_WIDGET_TYPE_UNKNOWN` | `warning` | A config page's widget names a type no composed contribution declares; it renders as unavailable. | Use a widget type a module provides, or install the module that provides it. |
| `UI_WIDGET_TYPE_DISABLED` | `warning` | A widget's type is declared only by a module that is not running; it renders as unavailable. Reported at `info` unless validation is strict. | Enable or fix the module that provides the widget type, or remove the widget. |
| `UI_WIDGET_SELECT_INVALID` | `error` | A widget's `select` is not a usable JMESPath expression: it does not parse, calls an unknown function or one with the wrong number of arguments, or exceeds the static limits (1024 characters, 256 parts, 8 multi-selects). Checked by the server entry's compositions (`composeChecked()`, `composeDefaultChecked()` from `@deck/schema/select`), which deck always uses; the browser-safe default composition does not check selects. | Correct the expression at the reported path; see jmespath.org for the syntax. |
| `UI_STATUS_MAP_UNKNOWN` | `warning` | A core widget's options name a status map (`statusMap`, at any depth) that `ui.statusMaps` does not declare; the widget shows those values without a tone. | Declare the status map under `ui.statusMaps`, or correct the name. |
| `UI_EMBED_DISALLOWED` | `info` | A `core/embed` widget is configured while `ui.allowUnsafeEmbeds` is not `true`; the widget frames nothing and shows that embeds are off. Checked on the merged document only, since the gate and the widget may be in different layers. | Set `ui.allowUnsafeEmbeds: true` to show other sites' pages in frames, or remove the widget. |
| `SECRET_VALUE_SUSPECTED` | `info` | A credential-related value resembles secret material. | Replace the value with a valid secret reference and keep secret material outside the document. |
| `SNAPSHOT_HOST_DUPLICATE` | `error` | A snapshot repeats an observed host. | Keep one observation for each host in the snapshot. |
| `SNAPSHOT_SERVICE_DUPLICATE` | `error` | A snapshot repeats an observed service identity. | Keep one observation for each service on a host. |
| `DRIFT_ID_DUPLICATE` | `error` | A snapshot repeats a drift finding id. | Give every drift finding a unique identifier. |
| `SNAPSHOT_HOST_UNDECLARED` | `error` | An observed host is absent from the config. | Declare the host in the configuration or remove its snapshot observation. |
| `SNAPSHOT_SERVICE_UNDECLARED` | `error` | An observed service is absent from the config. | Declare the service in the configuration or remove its snapshot observation. |
| `DRIFT_LOCATION_UNRESOLVED` | `error` | A drift location does not resolve in the config. | Correct the drift location so it resolves to a configured entity. |
| `HOST_NOT_COLLECTED` | `info` | A configured host has no snapshot observation. | Collect the host or confirm that its absence is expected. |

### Module host codes

Deck's module host reports these while planning modules from their manifests, and config validation reports `MODULE_SECTION_DISABLED` and `MODULE_RULE_FAILED` for a module's section. Both of those are `info`: a disabled or broken module is reported and set aside, never a reason to refuse the config. Deck's config loading also reports `MODULE_CREDENTIAL_ENV_REFUSED` for an instance's `credentialEnv`: at `warning` under `deck validate` (with or without `--advisory-disabled`), and as `info` when deck boots, which also logs it as a warning.

| Code | Severity | Trigger | Fix |
|---|---|---|---|
| `MODULE_MANIFEST_INVALID` | `warning` | A module manifest is unusable; the module is disabled. | Correct the manifest defect named in the message, or remove the module. |
| `MODULE_MANIFEST_CONFLICT` | `error` | Two modules, or a module and the kernel, claim the same id, route, health key or config contribution; boot fails. | Remove one of the conflicting modules or rename what they share. |
| `MODULE_API_INCOMPATIBLE` | `warning` | A module requires a module API version deck does not provide; it is disabled. | Install a module release built for this deck's module API. |
| `MODULE_DEPENDENCY_MISSING` | `warning` | A module depends on an absent or disabled module; it is disabled. | Enable the module it depends on, or remove the dependent module. |
| `MODULE_DEPENDENCY_CYCLE` | `warning` | A module is in, or depends on, a dependency cycle; it is disabled. | Break the cycle in the modules' dependsOn lists. |
| `MODULE_SECTION_DISABLED` | `info` | The config has a section for a module that is not enabled (not switched on, or its manifest is unusable); the section is ignored. One more is reported for each problem the module's schema, rules or identities would raise once enabled ("would fail when `<id>` is enabled"). | Enable the module, or remove its `modules.<id>` section. |
| `MODULE_KIND_HANDLER_FAILED` | `warning` | A module's provider-kind handler threw or returned something other than a list of offers while deck registered providers; the module is disabled and none of its providers are registered. | Fix the module's kind handler, or remove the module. |
| `MODULE_RULE_FAILED` | `info` | A module's config rule threw or reported a code its manifest does not declare; deck disables the module. | Fix the module's config rule, or remove the module. |
| `MODULE_CREDENTIAL_ENV_REFUSED` | `warning` | An `integrations[]` or `sources[]` instance's `credentialEnv` names a deck setting or a variable another module owns, which the module of the instance's kind may not read. `deck validate` (strict) also checks the kinds of modules that are switched off ("would fail when `<id>` is enabled"). | Set the credential in a variable that is neither a deck setting nor another module's, and name that one. |

## Provider kinds

Provider kinds are declared by contributions. Deck's data-source modules declare `link`, `http-health`, `docker`, `gatus`, `prometheus` and `alertmanager`; the kinds of built-in data sources that are not yet modules are `snapshot`, `markdown-tree` and `file-tree`.

The library's default composition (`composeDefault()`, used by `validate` and `merge` when no `composed` option is given) holds the kernel and the built-in contributions only, so it does **not** know the six module-owned kinds: a document that binds or integrates them gets `PROVIDER_KIND_UNKNOWN` there. Deck itself composes its modules in, so `deck validate` and boot know them. To validate such a document with the library alone, pass `composed: composeFixtures()` from `@deck/schema/fixtures`, whose `FIXTURE_DATA_SOURCES` stand-in declares the six kinds with their `bindable` flags and the docker, gatus, prometheus and alertmanager instance schemas (deck's tests keep it equal to the modules' manifests).

Provider `kind` remains an open string in the schema. An unregistered kind produces the `PROVIDER_KIND_UNKNOWN` warning rather than a schema error. To accept another kind, compose a contribution that declares it. A kind may also carry an instance schema: an `integrations[]` (or `sources[]`) entry of that kind must then match it, while an entry of any other kind keeps the generic shape.

## Widget types

Widget types are declared by contributions too (`widgetTypes`: `{ type: "<id>/<name>", optionsSchema? }`, where `<id>` is the contribution's own id; two contributions declaring one type is `MODULE_MANIFEST_CONFLICT`). A widget of a declared type (`ui.pages[].sections[].widgets[]`) must have `options` its type's schema accepts, so a bad option is a schema error at its path, which fails validation like any other. A widget's `type` stays an open string: an undeclared type is `UI_WIDGET_TYPE_UNKNOWN`, not a schema error. An explicit widget `id` is unique on its page (`ID_DUPLICATE`).

The library's default composition includes deck's own widget types (`core/stat`, `core/stat-grid`, `core/meter`, `core/key-value`, `core/list`, `core/table`, `core/status-grid`, `core/link-tiles`, `core/markdown`, `core/embed`, `core/health-pills` and `core/json`).

`ui.statusMaps` names maps from a widget's values to status tones: `values` (exact values, compared as text) and `rules` (tried in order: `lt`, `lte`, `gt`, `gte` and `eq` (either way round: as numbers when either side is a number and both read as one, else as text), every condition of a rule holding; a rule with none matches any value). A tone outside `ok`, `warn`, `danger`, `info`, `pending` and `neutral` is a schema error. A core widget's `statusMap` option naming a map the config does not declare is `UI_STATUS_MAP_UNKNOWN`. `ui.allowUnsafeEmbeds` (default `false`) lets `core/embed` widgets frame other sites' pages; a `core/embed` widget without it is `UI_EMBED_DISALLOWED`.

The JMESPath engine that checks and evaluates a widget's `select` (a modified copy of the jmespath.js 0.16.0 reference implementation, Apache-2.0: see `src/select/LICENSE` and the repository's `THIRD_PARTY_NOTICES.md`) is not part of the main entry, which stays browser-safe. **`validate()` and `composeDefault()` from the main entry do not check selects.** The server entry `@deck/schema/select` does: validate against `composeChecked(contributions)` or `composeDefaultChecked()` (or pass its `selectProblem` to `composeConfig`). It also exports `compileSelect`, `evaluateSelect`, `SELECT_LIMITS` and `FUNCTION_COSTS`, the work each built-in function is charged.

A kind declared `bindable` may appear as a key of `hosts[].bindings` and `services[].bindings`. A binding of a declared kind that is not bindable is ignored, as before, and reported with the info finding `PROVIDER_BINDING_UNSUPPORTED` so the dead binding is visible without failing validation.

## Secrets

A secret reference is an opaque id matching `^[a-z0-9]+(?:[.-][a-z0-9]+)*$` with maximum length `64`: lowercase alphanumeric components separated by `.` or `-`, without whitespace or `://`. Both schema files carry this exact pattern.

Credential-key matching lowercases names and removes `-` and `_`. The complete list is: `password`, `passwd`, `pass`, `passphrase`, `token`, `secret`, `apikey`, `credential`, `credentials`, `privatekey`, `accesskey`, `clientsecret`, `auth`, `authorization`, `bearer`.

A string under one of those keys that is not a valid reference, or any string matching a recognized token shape, produces the info finding `SECRET_VALUE_SUSPECTED`. Its message reports only path and value length, never the value.

## Minimal valid documents

The minimal valid config is:

```json
{
  "schemaVersion": 2,
  "estate": { "name": "example-estate" }
}
```

The minimal valid snapshot is:

```json
{
  "schemaVersion": 1,
  "generatedAt": "2020-01-01T00:00:00Z"
}
```

Absent collection keys are equivalent to empty arrays. Both documents validate with classification 0.

## Versioning policy

Config and snapshot each carry an integer `schemaVersion`, versioned independently: the config is at version 2 (`CONFIG_SCHEMA_VERSION`) and the snapshot at version 1 (`SNAPSHOT_SCHEMA_VERSION`). Each constant, its schema's `const`, and every fixture of that document must agree.

The number changes only for a breaking change: one that invalidates a formerly valid document or changes an existing field's meaning. Additive optional fields, enum members, provider kinds, and findings stay under the same number and receive a dated compatibility entry.

The library supports only the current version of each document. A config at version 1 is the `CONFIG_MIGRATION_REQUIRED` tool error (classification 2): rewrite it with `deck config migrate <dir>`. Any other unsupported readable integer produces `VERSION_UNSUPPORTED` and classification 1, with guidance to re-render using the projector pinned to the matching deck revision. A non-integer version is the `VERSION_UNREADABLE` tool error and classification 2.

## Compatibility note

This append-only history records each published change; breaking entries must give concrete re-render instructions.

| Version | Date | What changed | Projector action |
|---|---|---|---|
| 1 | 2026-09-02 | Initial published contract: config and snapshot schemas, finding catalog, known provider kinds, ownership, identity, and secret-reference rules. | Pin this deck revision, emit `schemaVersion: 1` in config and snapshot, validate both schemas, and use the library for semantic rules. |
| 1 | 2026-09-24 | Additive: optional top-level `llmUsage` section (Claude Code and Codex subscription usage limits), owned by the overlay layer. | None; existing documents stay valid. Emit `llmUsage` in the overlay only. |
| 2 | 2026-10-01 | Breaking, config only: module settings move under `modules.<id>` (`llmUsage` → `modules.llm-usage`, `groups` → `modules.portal.groups`, `actions` → `modules.actions.actions`); `agents` is removed; `ui` is reserved; the snapshot stays at version 1. | Emit `schemaVersion: 2` in config and keep `schemaVersion: 1` in snapshots. Rewrite existing config layers with `deck config migrate <dir>`. |
