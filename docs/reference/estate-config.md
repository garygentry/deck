# Estate configuration reference

This reference describes every key in a deck estate configuration.
The estate config projects your inventory and presentation into deck; it is authored as one or
more YAML layers that merge into a single document.
The authoritative shape is the JSON Schema at
[`packages/schema/schema/deck.schema.json`](../../packages/schema/schema/deck.schema.json)
for the top-level keys, composed with one schema per module section, kept beside the server module
that owns the section (such as
[`apps/server/src/portal/schema.json`](../../apps/server/src/portal/schema.json) and
[`apps/server/src/actions/schema.json`](../../apps/server/src/actions/schema.json)); the TypeScript
types are generated from each schema, and this page mirrors them.
For observed-reality data, see the [Snapshot contract reference](snapshot-contract.md).

## Document envelope

The top-level document is an object with no additional properties.

| Key | Type | Required | Description |
| --- | --- | --- | --- |
| `schemaVersion` | integer, const `2` | yes | The config schema version. Version 1 config must be migrated (see [Migrating from schemaVersion 1](#migrating-from-schemaversion-1)). |
| `estate` | object | yes | Estate-wide identity and conventions. |
| `hosts` | array of Host | no | Declared hosts; absent is equivalent to an empty array. |
| `services` | array of Service | no | Declared services; absent is equivalent to an empty array. |
| `sources` | array of Source | no | Document and configuration source declarations; absent is empty. |
| `integrations` | array of Integration | no | External tool integrations; absent is empty. |
| `ui` | object | no | Presentation settings: brand, theme, home page, navigation and extension overrides (see [ui](#ui)). Owned by the overlay layer. |
| `modules` | object | no | Module settings, one section per module id (see [Modules](#modules)). |

### Modules

`modules` holds each module's settings under its id. Each module defines the schema of its own
section, and a section for a module id deck does not have is rejected (`MODULE_UNKNOWN`), as
is any unknown key inside a section. A section for an installed module that is not running
(switched off, or with an unusable manifest) does not fail validation and may sit in either
layer: it is reported as the advisory `MODULE_SECTION_DISABLED`, together with anything the
module's schema and rules would report once it is enabled. The built-in sections are:

| Key | Type | Description |
| --- | --- | --- |
| `modules.portal` | object | The portal: `groups`, an array of [Group](#group); absent is equivalent to an empty array. |
| `modules.actions` | object | Governed actions: `actions`, an array of [Action](#action); absent is equivalent to an empty array. |
| `modules.llm-usage` | object | Claude Code and Codex plan-usage tracking (see [llm-usage](#modulesllm-usage)); absent turns the feature off. |

All three sections are owned by the overlay layer.

### Layer merge

deck loads every `*.yaml` file in the config directory, sorts them by filename, and merges
them in that order into one canonical document.
The first file is the base layer; each later file is an overlay folded onto the running result.
All layers must declare the same `schemaVersion`.

Arrays merge by identity, not by position: deck matches elements across layers by an identity
key, deep-merges matches, keeps base order, then appends new overlay elements.

| Array | Identity key |
| --- | --- |
| `hosts` | `name` |
| `services` | `host` + `name` |
| `sources`, `integrations`, `modules.portal.groups`, `modules.actions.actions`, `ui.nav.groups`, `ui.nav.items` | `id` |
| `modules.actions.actions[].params` | `name` |
| `hosts[].links`, `services[].links` | `href` |
| `modules.portal.groups[].items` | `service` → `host` + `name`; `link` → `href`; `group` → `id` |

## Estate

`estate` is an object with no additional properties; only `name` is required.

| Key | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | string | yes | Human-readable estate name shown in the shell header. |
| `domains` | object | no | Per-network domain suffixes keyed by network label. |
| `timezone` | string | no | IANA timezone name used by consumers for display. |
| `freshness` | object | no | Freshness defaults consumers use to derive staleness. |

`domains` keys match the pattern `^[a-z][a-z0-9-]*$`; each value is a domain suffix string for
the network named by the key.

`freshness` has one property:

| Key | Type | Required | Description |
| --- | --- | --- | --- |
| `snapshotStaleAfter` | string | no | ISO-8601 duration after which a snapshot is considered stale. |

## Inventory: hosts and services

### Host

A Host object has no additional properties.
`hypervisor` and `vmid` are mutually dependent: declaring one requires the other.

| Key | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | string | yes | Host name, unique across the config. |
| `kind` | HostKind | yes | What kind of host this is. |
| `purpose` | string | yes | One-line statement of what the host is for. |
| `status` | HostStatus | no | Declared lifecycle status rather than observed state. Independent of `hidden`. |
| `hypervisor` | string | with `vmid` | Name of the host that runs this guest. |
| `vmid` | integer ≥ 1 | with `hypervisor` | Numeric guest id on its hypervisor. |
| `addresses` | array of Address | no | Network addresses labelled by network. |
| `access` | Access | no | Reachability and collection-method summary, never credentials. |
| `backup` | Backup | no | Backup expectations for this host. |
| `managedConfigs` | array of ManagedConfig | no | Live config files mapped to source-of-truth files. |
| `stacksRoot` | string | no | Filesystem root under which container stacks live. |
| `secrets` | array of SecretRef | no | Opaque secret references this host depends on. |
| `links` | array of Link | no | Presentation links shown on the host card. |
| `bindings` | Bindings | no | Live-provider bindings keyed by provider kind. |
| `hidden` | boolean | no | Hide this host from default views without affecting validation. |

`HostKind` is one of: `bare-metal`, `vm`, `lxc`, `appliance`, `endpoint`, `unknown`.
`HostStatus` is one of: `active`, `planned`, `retired`. Omitting it leaves the host's lifecycle unspecified.

### Service

A Service object has no additional properties.

| Key | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | string | yes | Service name, unique per host. |
| `host` | string | yes | Name of the host this service runs on. |
| `kind` | ServiceKind | yes | What kind of service this is. |
| `purpose` | string | yes | One-line statement of what the service is for. |
| `status` | ServiceStatus | no | Declared lifecycle status rather than observed state. |
| `stack` | string | no | Stack directory when it differs from the service name. |
| `secrets` | array of SecretRef | no | Opaque secret references this service depends on. |
| `backup` | Backup | no | Backup expectations for this service. |
| `links` | array of Link | no | Presentation links shown on the service card. |
| `bindings` | Bindings | no | Live-provider bindings keyed by provider kind. |
| `hidden` | boolean | no | Hide this service from default views without affecting validation. |

`ServiceKind` is one of: `docker-compose`, `systemd`, `appliance`, `container`, `external`.
`ServiceStatus` is one of: `active`, `planned`, `retired`.

### Address

| Key | Type | Required | Description |
| --- | --- | --- | --- |
| `network` | string | yes | Network label for this address, e.g. `lan` or `tailnet`. |
| `address` | string | yes | The address on that network. |
| `primary` | boolean | no | Whether this is the host's primary address on that network. |

### Access

An Access object has no additional properties; every field is optional.

| Key | Type | Description |
| --- | --- | --- |
| `reachable` | boolean | Whether the host is expected to be reachable. |
| `method` | `ssh` \| `api` \| `none` | Expected collection or access method. |
| `port` | integer | Network port used by the access method. |
| `user` | string | Non-secret user name used for access. |
| `sudo` | boolean | Whether privileged elevation is expected. |
| `notes` | string | Additional non-secret access notes. |

### Backup

| Key | Type | Required | Description |
| --- | --- | --- | --- |
| `expected` | boolean | yes | Whether this entity is expected to be backed up. |
| `schedule` | string | no | Human-readable backup schedule. |
| `target` | string | no | Non-secret backup destination identifier. |
| `notes` | string | no | Additional backup notes. |

### ManagedConfig

| Key | Type | Required | Description |
| --- | --- | --- | --- |
| `path` | string | yes | Live configuration file path. |
| `source` | string | yes | Owning source-of-truth file reference. |
| `notes` | string | no | Additional management notes. |

### Link

| Key | Type | Required | Description |
| --- | --- | --- | --- |
| `title` | string | yes | Human-readable link label. |
| `href` | string | yes | Link target URL. |
| `icon` | string | no | Optional icon token. |

### Bindings and SecretRef

`Bindings` is an object of live-provider bindings keyed by provider kind; keys match
`^[a-z][a-z0-9-]*$` and values are provider-defined. Only a kind whose module accepts bindings
may appear: an unknown kind is reported as `PROVIDER_KIND_UNKNOWN`, and a known kind that does
not accept bindings as `PROVIDER_BINDING_UNSUPPORTED` (info: the binding is ignored). The built-in bindable
kinds are `link` and `http-health` (each binding becomes a provider), `docker` and `gatus`
(a binding selects entries from that integration's provider), and `snapshot`. `prometheus` and
`alertmanager` are integration-only: a binding of either is reported as
`PROVIDER_BINDING_UNSUPPORTED`. The source kinds `markdown-tree` and `file-tree` are not bindable
either: a source names its host or service in its own `owner`.

`SecretRef` is a string holding an opaque secret reference id, never a secret value.
It matches `^[a-z0-9]+(?:[.-][a-z0-9]+)*$` and is at most 64 characters.

## Portal: groups and items

These live under `modules.portal.groups`.

### Group

| Key | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | string | yes | Group id, unique across the groups tree. |
| `title` | string | yes | Group heading shown in the portal. |
| `order` | integer | no | Sort key among sibling groups. |
| `icon` | string | no | Icon token for the group heading. |
| `items` | array of GroupItem | yes | Ordered service, link, or subgroup items. |

A `GroupItem` is one of three shapes, discriminated by `type`: a ServiceItem, a LinkItem, or a
Subgroup.

### ServiceItem

| Key | Type | Required | Description |
| --- | --- | --- | --- |
| `type` | const `service` | yes | Discriminator for a declared service reference. |
| `host` | string | yes | Host name of the referenced service. |
| `name` | string | yes | Service name on the referenced host. |
| `title` | string | no | Label override. |
| `icon` | string | no | Icon token. |
| `description` | string | no | One-line description. |

### LinkItem

| Key | Type | Required | Description |
| --- | --- | --- | --- |
| `type` | const `link` | yes | Discriminator for a plain external link. |
| `title` | string | yes | Link label. |
| `href` | string | yes | Link target URL. |
| `icon` | string | no | Icon token. |
| `description` | string | no | One-line description. |

### Subgroup

A subgroup is one level deep: its `items` accept only ServiceItem and LinkItem entries, and
nested subgroups are forbidden.

| Key | Type | Required | Description |
| --- | --- | --- | --- |
| `type` | const `group` | yes | Discriminator for a one-level subgroup. |
| `id` | string | yes | Subgroup id, unique across the groups tree. |
| `title` | string | yes | Subgroup heading. |
| `order` | integer | no | Sort key among sibling items. |
| `icon` | string | no | Icon token. |
| `items` | array of ServiceItem or LinkItem | yes | Service or link items only. |

## Sources, integrations, actions

Source ids, integration ids and host and service binding ids share one provider-id space. A
binding's id is its own `id` if it has one, otherwise `<kind>:host:<host>` or
`<kind>:service:<host>:<service>`; boot registers bindings under exactly these ids. Keep them
distinct: `deck validate` reports an id used in two collections, or by two bindings, as
`PROVIDER_ID_SHARED` (a warning, `info` at boot). Not every declaration registers a provider
(some kinds register under a fixed id, others not at all), so a shared id is not always a
clash; when both declarations do register, boot fails with `PROVIDER_DUPLICATE_ID`. A repeat
within `sources` or within `integrations` is an `ID_DUPLICATE` error.

### Source

A Source object has no additional properties.

| Key | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | string | yes | Source id, unique across sources. |
| `kind` | string | yes | Open source kind string. |
| `title` | string | yes | Human-readable source title. |
| `location` | object | yes | Filesystem or repository source location. |
| `include` | array of string | no | Include glob patterns. |
| `exclude` | array of string | no | Exclude glob patterns. |
| `owner` | object | no | Owning host, and optionally service. |
| `credentialEnv` | string | no | Environment variable **name** holding a credential, never its value. |

`location` has no additional properties:

| Key | Type | Required | Description |
| --- | --- | --- | --- |
| `path` | string | no | Filesystem path to the source root. |
| `repo` | string | no | Repository reference. |
| `ref` | string | no | Revision or branch. |

`owner` requires `host` and accepts an optional `service` (the owning service name on that
host).

`credentialEnv` holds the **name** of an environment variable, matching `^[A-Z][A-Z0-9_]*$`.
It never holds the secret value itself; supply the value to the deployment's environment.

### Integration

An Integration object has no additional properties.

| Key | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | string | yes | Integration id, unique across integrations. |
| `kind` | string | yes | Open provider kind string. |
| `title` | string | yes | Human-readable integration title. |
| `baseUrl` | string | yes | Base URL of the integrated tool. |
| `deepLink` | string | no | Deep-link template into the tool. |
| `card` | object | no | Opaque provider-defined card specification. |
| `credentialEnv` | string | no | Environment variable **name** holding a credential, never its value. |

`credentialEnv` follows the same rule as on a Source: it is an env-var name matching
`^[A-Z][A-Z0-9_]*$`, never a secret value.

A `credentialEnv` (on an integration or a source) may not name a deck setting (`DECK_CONFIG_DIR`,
`DECK_DATA_DIR`, `DECK_LOG_LEVEL`, `DECK_PORT`, `DECK_SNAPSHOT_OUT`, `DECK_WEB_DIST`) or a
variable another module owns (`DECK_SNAPSHOT_SOURCE`, say): the module of the instance's kind
may not read it. Boot logs a `provider.credential-env-refused` warning (the name, never the
value) and carries on without that variable, and `deck validate` reports
`MODULE_CREDENTIAL_ENV_REFUSED` (a warning).

### Action

Actions live under `modules.actions.actions`. An Action object has no additional properties.

| Key | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | string | yes | Action id, unique across actions. |
| `title` | string | yes | Human-readable action label. |
| `runner` | string | yes | Estate-side runner or playbook **name**, never a command. |
| `confirm` | `none` \| `confirm` \| `typed-confirm` | yes | UI confirmation the web app requires before it posts the run. The server does not enforce it. |
| `params` | array of ActionParam | no | Typed parameters accepted by the runner. |
| `target` | object | no | Host, and optionally service, the action targets. |
| `description` | string | no | Longer action description. |

`runner` is a runner name resolved at run time, not a shell command; deck never builds a
command from config.
`target` requires `host` and accepts an optional `service`.

An `ActionParam` has no additional properties:

| Key | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | string | yes | Parameter name, unique within the action. |
| `type` | `string` \| `number` \| `boolean` \| `enum` | yes | Parameter value type. |
| `required` | boolean | no | Whether the parameter must be supplied. |
| `default` | JSON value | no | Default value matching the declared type. |
| `values` | array of string | no | Allowed values when the type is `enum`. |
| `description` | string | no | Parameter description. |

## ui

`ui` holds presentation settings. It is owned by the overlay layer: a `ui` value in the base
layer is reported as `LAYER_OVERLAY_KEY_IN_BASE`. Every key is optional, and with no `ui` section
deck renders as it always has. The section and each object in it accept no additional properties.
Colours are never configurable: the theme is chosen by name.

```yaml
ui:
  brand: { title: Gentry Lab, icon: server }
  theme: { mode: dark }
  home: page:inventory/hosts
  extensions:
    pill:drift/summary: false
```

| Key | Type | Description |
| --- | --- | --- |
| `brand` | object | The product name and mark in the sidebar, the browser tab and the page title. |
| `theme` | object | The operator's theme defaults. |
| `home` | string | The id of the page `/` renders, such as `page:inventory/hosts`. Default: the portal (`page:portal/overview`). |
| `nav` | object | Sidebar group order, labels and icons, and extra nav entries. |
| `extensions` | object | Overrides by extension, page or nav entry id. |

`brand`:

| Key | Type | Description |
| --- | --- | --- |
| `title` | string, 1–80 characters, not blank | The name shown in the sidebar, the document title (`{page} · {title}`) and `index.html`'s `<title>`. Default: `estate.name`, then `Deck`. |
| `icon` | icon name | An icon from the shell's icon set, shown in the sidebar mark in place of the title's initial. A name the shell does not have shows the initial. |
| `logoUrl` | string | An `http(s)://` URL or a root-relative path (`/logo.svg`) to an image, shown as the sidebar mark in place of the icon. If it fails to load, the initial shows. |

`theme`:

| Key | Type | Description |
| --- | --- | --- |
| `mode` | `light` \| `dark` \| `system` | The colour mode for a viewer who has not chosen one in the theme menu; default `system`. A viewer's own choice always wins. It is written into the page, so the first paint already uses it. |
| `preset` | `teal` | The named colour preset; default `teal`. |
| `density` | `compact` \| `comfortable` | Spacing of tables, lists and sections. Accepted; the shell does not apply it yet. |
| `radius` | `none` \| `sm` \| `md` \| `lg` | Corner radius scale. Accepted; the shell does not apply it yet. |

`home`: `/` renders the home page, and the page also stays at its own path; its sidebar entry
links to `/`. The portal is the default home and is also served at `/portal`. A page with path
parameters (`/hosts/:name`) cannot be home. A `home` naming an unknown page, a page of a module
that is off or switched off by an override, or a page with parameters leaves the portal as home
and is reported in `GET /api/ui` as `UI_HOME_UNKNOWN`, `UI_HOME_DISABLED` or
`UI_HOME_NOT_ROUTABLE`; it never stops deck from starting.

`nav` (accepted and validated; the shell does not apply it yet):

| Key | Type | Description |
| --- | --- | --- |
| `groups` | array of `{id, label?, icon?}` | Groups in sidebar order; groups not listed follow by id. |
| `items` | array | Extra entries: a link `{id, group, label, href, icon?, order?}`, where `id` is `nav:<module>/<name>` and `href` is an `http(s)://` URL, or a separator `{id, group, separator: true, order?}`. |

Both arrays merge across overlays by `id`, and an id repeated in one layer is `ID_DUPLICATE`.

`extensions` maps an extension, page or nav entry id (as `GET /api/ui` lists them) to an
override that replaces its default, never merges into it:

- `false` hides it (a page's nav entry goes with the page), and `true` shows it.
- An object takes `enabled`, `attachTo` (`slot`, `order`) and `config`. A page takes only
  `enabled`; a nav entry `enabled` and `attachTo`. An omitted `attachTo.slot` keeps the slot,
  and an omitted `attachTo.order` is 100. `config` replaces the extension's config wholesale.
- `attachTo.group` (moving a nav entry to another group) is accepted but not applied yet.

An override for an id deck does not know, or one that does not fit its target, is reported in
`GET /api/ui` (`UI_UNKNOWN_EXTENSION`, `UI_INVALID_OVERRIDE`) and otherwise ignored.

## modules.llm-usage

`modules.llm-usage` is an object with no additional properties. Every key is optional, and an absent
section turns the feature off (no polling, no ingest route).
See [Track Claude Code and Codex plan usage](../guides/llm-usage.md) for the walkthrough.

| Key | Type | Required | Description |
| --- | --- | --- | --- |
| `claude` | object | no | Claude Code (Claude.ai Pro/Max) usage; presence enables the Claude panel. |
| `codex` | object | no | Codex (ChatGPT plan) usage; presence enables the Codex panel. |
| `thresholds` | object | no | `warn` and `danger` percent-used bands, each 0–100; defaults 75 and 90. An explicit `warn` must not exceed `danger`; a lone `danger` below 75 lowers `warn` to match. |
| `idlePause` | ISO-8601 duration | no | Time without a viewer after which upstream polling pauses; default `PT5M`. |

`claude` has no additional properties:

| Key | Type | Required | Description |
| --- | --- | --- | --- |
| `credentialsFile` | string | no | Path to a Claude Code `.credentials.json` (mount read-only); enables the OAuth usage source. Deck never writes or refreshes it. |
| `transcriptsDir` | string | no | Path to a Claude Code `projects` directory for the token-count scan. |
| `statusLine` | object | no | statusLine hook ingest. Its required `credentialEnv` names the env var holding the ingest bearer token. |
| `activeInterval` | ISO-8601 duration | no | OAuth poll interval while a session is active; default `PT2M`, clamped to `PT2M`–`P1D`. |
| `idleInterval` | ISO-8601 duration | no | OAuth poll interval while idle; default `PT5M`, clamped to `PT2M`–`P1D`. |

`codex` has no additional properties; only `codexHome` is required:

| Key | Type | Required | Description |
| --- | --- | --- | --- |
| `codexHome` | string | yes | `CODEX_HOME` directory holding `auth.json` (mount the host's `~/.codex` read-write, at the same path; the app-server refreshes it). |
| `command` | string | no | Codex executable as deck sees it; defaults to `codex` on `PATH`. The deck image ships no Codex: mount the host's Linux binary and point this at it. |
| `rolloutDir` | string | no | Rollout sessions directory; defaults to `<codexHome>/sessions`. |

`deck validate` reports a malformed or zero duration, or an explicit `warn` above `danger`, as
`LLM_USAGE_INVALID` (malformed durations as `SCHEMA_INVALID`); deck refuses to start with them.

## Migrating from schemaVersion 1

Deck accepts only `schemaVersion: 2`. A version 1 config fails `deck validate` and boot with
`CONFIG_MIGRATION_REQUIRED` (exit 2), naming the command that fixes it:

```sh
deck config migrate <config dir> --dry-run   # print the change as a unified diff; write nothing
deck config migrate <config dir>             # rewrite every layer in place
deck validate <config dir>
```

The migration rewrites each YAML layer on its own, so every key stays in the layer it was in:

| schemaVersion 1 | schemaVersion 2 |
| --- | --- |
| `schemaVersion: 1` | `schemaVersion: 2` |
| `groups` | `modules.portal.groups` |
| `actions` | `modules.actions.actions` |
| `llmUsage` | `modules.llm-usage` |
| `agents` | removed (reserved and never used; a warning is printed if it had entries) |

It moves the original lines, re-indented, so comments, quoting, flow styles and line endings
are kept, and a symlinked layer is migrated at its target. A layer already at version 2 is left
untouched, so running it twice changes nothing. If any layer cannot be migrated (an
unsupported version, a flow-style root, a version 1 layer that already has `modules`), no file
is written. See the [CLI reference](cli.md#deck-config-migrate) for the details. Snapshots are unaffected: they stay at their own
`schemaVersion: 1`.

## See also

- Authoring workflow: [Configure your estate](../guides/configure-your-estate.md).
- Validation and rendering: [CLI reference](cli.md).
- Observed-reality data: [Snapshot contract reference](snapshot-contract.md).
- Authoritative schema:
  [`packages/schema/schema/deck.schema.json`](../../packages/schema/schema/deck.schema.json).
