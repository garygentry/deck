# `@deck/schema` contract

This is the human-facing contract for version 1 of deck config and snapshot documents.

## Schema files & consumption

The stable schema files are `schema/deck.schema.json` (exported as `@deck/schema/deck.schema.json`) and `schema/snapshot.schema.json` (exported as `@deck/schema/snapshot.schema.json`). Both are standalone JSON Schema draft 2020-12 documents. A projector can vendor a pinned checkout and validate its output with a conforming JSON Schema implementation in any language.

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
| `groups` | `overlay` |
| `sources` | `overlay` |
| `integrations` | `overlay` |
| `llmUsage` | `overlay` |
| `actions` | `overlay` |
| `agents` | `overlay` |

### Identity rules

Identity-keyed arrays pair elements using these fields. Identity values must be unique; group ids are unique across the entire group tree.

| Collection | Identity definition |
|---|---|
| `hosts` | `["name"]` |
| `services` | `["host","name"]` |
| `groups` | `["id"]` |
| `groups[].items` | `{"service":["host","name"],"link":["href"],"group":["id"]}` |
| `groups[].items[].items` | `{"service":["host","name"],"link":["href"]}` |
| `hosts[].links` | `["href"]` |
| `services[].links` | `["href"]` |
| `sources` | `["id"]` |
| `integrations` | `["id"]` |
| `actions` | `["id"]` |
| `actions[].params` | `["name"]` |
| `agents` | `["id"]` |

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

Validators accept already-parsed objects, perform no I/O, and never throw. Passing `base` when validating an overlay is mandatory: it is how `OVERLAY_DANGLING_REF` is detected before merge. `merge` can throw `MergeError` for non-object input, version mismatch, or a missing identity; callers map that failure to exit classification 2.

## The finding model

A `Finding` has a stable machine-readable `code`, a `severity`, an RFC 6901 JSON Pointer `path` (`""` is the root), a human-readable `message`, and an optional `hint`. The shared severity vocabulary is `error | warning | info`.

Exit classification is: `0` when there are no errors or warnings (info is allowed), `1` when any warning or error exists, and `2` for a tool error such as unreadable input/version or an internal failure. Tool errors carry no findings. `classify(findings)` returns only `0 | 1`; classification 2 is a separate arm of `ValidationResult`.

## Two-tier consumer model

Tier 1 travels in the draft-2020-12 JSON schemas and is enforced by conforming validators: object shape and `additionalProperties`, `required`, `enum` and `const`, `pattern`, `format: date-time`, `dependentRequired`, and `if`/`then`.

Tier 2 is enforced only by the library: identity uniqueness, referential integrity, layer ownership and dangling overlay references, unknown provider kinds, secret heuristics, and snapshot/config cross-checks. A non-TypeScript consumer using only the JSON schemas receives shape checks, not these semantic checks.

## Finding codes

Each code has a fixed severity. Trigger describes when it is emitted; Fix gives the corrective action.

### Schema-level codes

| Code | Severity | Trigger | Fix |
|---|---|---|---|
| `VERSION_UNSUPPORTED` | `error` | The document uses an unsupported integer schema version. | Change the document to a schema version supported by this library. |
| `SCHEMA_INVALID` | `error` | A value does not match the required schema shape. | Correct the value at the reported path to match the schema. |
| `SCHEMA_UNKNOWN_PROPERTY` | `error` | A closed object contains an undeclared property. | Remove the unknown property or move its data to a supported field. |
| `SCHEMA_REQUIRED_MISSING` | `error` | A required property is absent. | Add the required property at the reported path. |

### Library-only semantic rules

| Code | Severity | Trigger | Fix |
|---|---|---|---|
| `HOST_DUPLICATE` | `error` | More than one host has the same name. | Give every host a unique name. |
| `SERVICE_DUPLICATE` | `error` | More than one service has the same host/name identity. | Give every service on the host a unique name. |
| `ID_DUPLICATE` | `error` | An id is repeated where it must be unique. | Replace the duplicate identifier with a unique value. |
| `REF_HOST_UNRESOLVED` | `error` | A host reference has no declared target. | Point the reference to an existing host or declare the missing host. |
| `REF_SERVICE_UNRESOLVED` | `error` | A service reference has no declared target. | Point the reference to an existing service or declare the missing service. |
| `LAYER_OVERLAY_KEY_IN_BASE` | `warning` | The base contains an overlay-owned property. | Move the reported presentation property to the overlay layer. |
| `LAYER_BASE_KEY_IN_OVERLAY` | `error` | The overlay contains a base-owned property. | Move the reported inventory property to the base layer. |
| `OVERLAY_DANGLING_REF` | `error` | An overlay reference does not resolve against the base. | Correct the reference or add its target to the base layer. |
| `PROVIDER_KIND_UNKNOWN` | `warning` | A provider kind is outside the known registry and per-call extensions. | Use a known provider kind or register the additional kind for validation. |
| `SECRET_VALUE_SUSPECTED` | `info` | A credential-related value resembles secret material. | Replace the value with a valid secret reference and keep secret material outside the document. |
| `SNAPSHOT_HOST_DUPLICATE` | `error` | A snapshot repeats an observed host. | Keep one observation for each host in the snapshot. |
| `SNAPSHOT_SERVICE_DUPLICATE` | `error` | A snapshot repeats an observed service identity. | Keep one observation for each service on a host. |
| `DRIFT_ID_DUPLICATE` | `error` | A snapshot repeats a drift finding id. | Give every drift finding a unique identifier. |
| `SNAPSHOT_HOST_UNDECLARED` | `error` | An observed host is absent from the config. | Declare the host in the configuration or remove its snapshot observation. |
| `SNAPSHOT_SERVICE_UNDECLARED` | `error` | An observed service is absent from the config. | Declare the service in the configuration or remove its snapshot observation. |
| `DRIFT_LOCATION_UNRESOLVED` | `error` | A drift location does not resolve in the config. | Correct the drift location so it resolves to a configured entity. |
| `LLM_USAGE_INVALID` | `error` | An `llmUsage` duration is zero, or an explicit `thresholds.warn` exceeds `thresholds.danger`. | Use positive ISO-8601 durations and keep thresholds.warn at or below thresholds.danger. |
| `HOST_NOT_COLLECTED` | `info` | A configured host has no snapshot observation. | Collect the host or confirm that its absence is expected. |

## Provider kinds

The known registry is: `link`, `docker`, `gatus`, `prometheus`, `alertmanager`, `snapshot`, `markdown-tree`, `file-tree`, `http-health`.

Provider `kind` remains an open string in the schema. An unregistered kind produces the `PROVIDER_KIND_UNKNOWN` warning rather than a schema error. Extend the registry for one validation call with `options.knownKinds`; do not mutate the exported constant.

## Secrets

A secret reference is an opaque id matching `^[a-z0-9]+(?:[.-][a-z0-9]+)*$` with maximum length `64`: lowercase alphanumeric components separated by `.` or `-`, without whitespace or `://`. Both schema files carry this exact pattern.

Credential-key matching lowercases names and removes `-` and `_`. The complete list is: `password`, `passwd`, `pass`, `passphrase`, `token`, `secret`, `apikey`, `credential`, `credentials`, `privatekey`, `accesskey`, `clientsecret`, `auth`, `authorization`, `bearer`.

A string under one of those keys that is not a valid reference, or any string matching a recognized token shape, produces the info finding `SECRET_VALUE_SUSPECTED`. Its message reports only path and value length, never the value.

## Minimal valid documents

The minimal valid config is:

```json
{
  "schemaVersion": 1,
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

Config and snapshot share one integer `schemaVersion`; version 1 is the first published version. `SCHEMA_VERSION`, both schemas' `const`, and every fixture must agree.

The number changes only for a breaking change: one that invalidates a formerly valid document or changes an existing field's meaning. Additive optional fields, enum members, provider kinds, and findings stay under the same number and receive a dated compatibility entry.

The library supports only the current version. Any other readable integer produces `VERSION_UNSUPPORTED` and classification 1, with guidance to re-render using the projector pinned to the matching deck revision. A non-integer version is the `VERSION_UNREADABLE` tool error and classification 2. There is no in-library migration.

## Compatibility note

This append-only history records each published change; breaking entries must give concrete re-render instructions.

| Version | Date | What changed | Projector action |
|---|---|---|---|
| 1 | 2026-09-02 | Initial published contract: config and snapshot schemas, finding catalog, known provider kinds, ownership, identity, and secret-reference rules. | Pin this deck revision, emit `schemaVersion: 1` in config and snapshot, validate both schemas, and use the library for semantic rules. |
| 1 | 2026-09-24 | Additive: optional top-level `llmUsage` section (Claude Code and Codex subscription usage limits), owned by the overlay layer. | None; existing documents stay valid. Emit `llmUsage` in the overlay only. |
