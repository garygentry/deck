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
(a binding selects entries from that integration's provider), and `snapshot`. A `docker`,
`gatus` or `http-health` binding gives the service's portal card its live status. `prometheus` and
`alertmanager` are integration-only: a binding of either is reported as
`PROVIDER_BINDING_UNSUPPORTED`. The source kinds `markdown-tree` and `file-tree` are not bindable
either: a source names its host or service in its own `owner`.

`SecretRef` is a string holding an opaque secret reference id, never a secret value.
It matches `^[a-z0-9]+(?:[.-][a-z0-9]+)*$` and is at most 64 characters.

## Portal: groups and items

These live under `modules.portal.groups`.

The portal page (`page:portal/overview`) is a dashboard: the `portal/summary` slot's cards,
then one `portal/groups` widget (`widget:portal/overview.groups`) showing every group.
`ui.extensions` can switch that widget off by id; a config page can place `portal/groups`, with
a `groups` option to show only some groups (see `ui.pages` under [ui](#ui)).

A service card's status comes from the service's first binding of a kind whose module declares
how its data gives a status, and whose provider is registered: the built-in kinds first, in the
order `docker` (the container is running, and healthy or without a health check), `gatus` (the
endpoint is up), `http-health` (the probe answered 2xx or 3xx), then other modules' kinds by
name. A service with none of these is a plain link card. A card whose provider has not answered
yet says "Checking"; the rest of the portal renders meanwhile.

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

#### http-json integrations

An integration of kind `http-json` has its own shape in place of the one above: it polls a URL
and serves the parsed JSON response as provider data. It has no `baseUrl` or `card`. It has no
additional properties.

| Key | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | string | yes | Integration id; also the provider id. Not the fixed provider id of another integration in the estate. |
| `kind` | `http-json` | yes | |
| `title` | string | yes | Human-readable integration title. |
| `url` | string | yes | `http://` or `https://` URL the runtime's parser accepts, at most 2048 characters, without `user:password@`, and with no query parameter whose name looks like a credential. |
| `method` | `GET` \| `POST` | no | Default `GET`. |
| `body` | any JSON | no | Request body, sent with `POST` only. No key in it may look like a credential. |
| `headers` | object of string | no | Literal, non-secret request headers. Names are HTTP tokens, and one that names a credential (`Authorization`, `Cookie`, `X-Api-Key`, …) is refused; the rule is in the provider kinds reference. Values are at most 1024 characters of printable ASCII or tab. |
| `credentialEnv` | string | no | Environment variable **name** holding the credential. |
| `auth` | object | no | `{ scheme: bearer \| basic \| header \| query, header?, param? }`; requires `credentialEnv`. `header` names the header for scheme `header`, and `param` the query parameter for scheme `query`; each is allowed only with its scheme. |
| `pollIntervalMs` | integer | no | 1000–86400000; default 30000. |
| `ttlMs` | integer | no | 1000–86400000; default the poll interval. |
| `timeoutMs` | integer | no | 100–60000; default 5000. |
| `maxBytes` | integer | no | 1–16777216; default 1048576. |
| `deepLink` | string | no | Link to the API's own UI. |

The credential only ever comes from the variable `credentialEnv` names, under the rule above;
config holds no secret. Beyond the schema, `deck validate` reports `HTTP_JSON_URL_INVALID` (a URL
the runtime parser rejects), `HTTP_JSON_LITERAL_CREDENTIAL` (a credential-like query parameter
or body key) and `HTTP_JSON_ID_RESERVED` (the fixed provider id of another integration in the estate), all
errors. The credential variable must hold at least 8 characters, with no surrounding whitespace. See the [provider kinds reference](provider-kinds.md#http-json) for how
it is sent, how redirects and failures are handled, and an example.

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
| `extensions` | object | Overrides by extension, page, nav entry or widget id. |
| `pages` | array | Config-defined pages (dashboards): sections of widgets. |
| `statusMaps` | object | Named maps from widget values to status tones, which widgets name in their `statusMap` option. |

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
| `preset` | `teal` \| `slate` \| `copper` \| `rose` \| `high-contrast` | The named colour preset; default `teal`. `slate`, `copper` and `rose` change the accent (primary, links, focus ring, selection), chosen to stay clearly apart from every status colour; `high-contrast` also strengthens text (7:1), controls (4.5:1, the destructive button 7:1) and edges (3:1). Status colours keep their meaning in every preset. |
| `density` | `compact` \| `comfortable` | Spacing of tables, lists and sections; default `comfortable`. `compact` tightens table cells, list rows and groups, section gaps and padding, and empty states. Spacing a screen sets explicitly is left as it is. |
| `radius` | `none` \| `sm` \| `md` \| `lg` | Corner radius scale; default `md`. `none` squares every corner except round avatars and pills. |

Every setting is written into the page with `mode`, so the first paint already uses it, and
none of them takes a colour value: a preset is a named, contrast-tested token set in the shell.
The viewer's theme menu chooses only the mode.

`home`: `/` renders the home page, and the page also stays at its own path; its sidebar entry
links to `/`. The portal is the default home and is also served at `/portal`. A page with path
parameters (`/hosts/:name`) cannot be home. A `home` naming an unknown page, a page of a module
that is off or switched off by an override, or a page with parameters leaves the portal as home
and is reported in `GET /api/ui` as `UI_HOME_UNKNOWN`, `UI_HOME_DISABLED` or
`UI_HOME_NOT_ROUTABLE`; it never stops deck from starting.

`nav` arranges the sidebar:

```yaml
ui:
  nav:
    groups:
      - { id: overview }
      - { id: health, label: Monitoring }
      - { id: lab, label: Lab, icon: boxes }   # a new group
    items:
      - { id: nav:ui/grafana, group: lab, label: Grafana, href: "https://grafana.example.net", icon: gauge, order: 10 }
      - { id: nav:ui/divider, group: lab, separator: true, order: 20 }
      - { id: nav:ui/prometheus, group: lab, label: Prometheus, href: "https://prometheus.example.net", order: 30 }
```

| Key | Type | Description |
| --- | --- | --- |
| `groups` | array of `{id, label?, icon?}` | Groups in sidebar order (across layers, see below). The built-in groups (`overview`, `inventory`, `health`, `operate`, `knowledge`) that are not listed follow in that order, then any other group an entry names, by id. `label` replaces the heading (default: the built-in heading, else the id); `icon` is shown beside it. An id that is not built in is a new group. |
| `items` | array | Extra entries: a link `{id, group, label, href, icon?, order?}`, where `id` is `nav:ui/<name>` and `href` is an `http(s)://` URL, or a separator `{id, group, separator: true, order?}`. `order` places the entry among the group's others (built-in entries are 100; the portal is -1); default 100. |

Both arrays merge across overlays by `id`, and an id repeated in one layer is `ID_DUPLICATE`.
A later layer that lists a group again merges into it (its `label` or `icon` wins) but does not
move it: the merged `groups` keep the first layer's positions and append the ids a later layer
adds, so set the order in the first layer that lists groups.

A group is shown only when an entry is in it. A link opens in a new tab, with an external-link
mark and "(opens in new tab)" in its accessible name. A separator draws a rule between two
entries, so it needs an entry on each side within its group (by `order`): one at either end of
a group, or next to another separator, is dropped. Item ids are always `nav:ui/<name>`, a
namespace no module can use, and in `GET /api/ui` these entries are listed with module `ui`.
They take `extensions` overrides like any other nav entry.

`extensions` maps an extension, page or nav entry id (as `GET /api/ui` lists them) to an
override that replaces its default, never merges into it:

- `false` hides it (a page's nav entry goes with the page), and `true` shows it.
- An object takes `enabled`, `attachTo` (`slot`, `order`, and for a nav entry `group`) and
  `config`. A page takes only `enabled`; a nav entry `enabled` and `attachTo`. `attachTo`
  replaces the default as a whole: an omitted `slot` or `group` keeps the current one, and an
  omitted `order` is 100. `config` replaces the extension's config wholesale.

Across layers, entries for different ids merge, and a later layer's entry for the same id
replaces the earlier one's `attachTo` and `config` whole: with
`nav:actions/overview: { attachTo: { group: lab } }` in one overlay and
`nav:actions/overview: { attachTo: { order: 9 } }` in a later one, the entry stays in its own
group at order 9.

```yaml
ui:
  extensions:
    pill:drift/summary: false                                   # hide a header pill
    pill:llm-usage/summary: { attachTo: { order: 5 } }          # put a pill first
    nav:actions/overview: { attachTo: { group: lab, order: 10 } } # move a nav entry to another group
    page:llm-usage/overview: false                              # hide a page and its nav entry
```

An override for an id deck does not know, or one that does not fit its target, is reported in
`GET /api/ui` (`UI_UNKNOWN_EXTENSION`, `UI_INVALID_OVERRIDE`) and otherwise ignored.

`pages` defines pages of your own, built from widgets over the data deck already collects:

```yaml
ui:
  pages:
    - id: lab
      path: /lab
      title: Lab overview
      icon: gauge
      nav: { group: lab, order: 0 }
      sections:
        - title: Inventory
          columns: 3
          widgets:
            - { id: hosts, type: core/json, title: Host names, source: snapshot, select: "snapshot.hosts[].name", span: 2 }
            - { id: count, type: core/json, title: Host count, source: { kind: snapshot }, select: "length(snapshot.hosts)" }
```

A page:

| Key | Type | Description |
| --- | --- | --- |
| `id` | string, lowercase letters, digits and `-` | The page's name. Its id is `page:ui/<id>`, which `home` and `extensions` take. Unique (`ID_DUPLICATE`); pages merge across overlays by `id`. |
| `path` | string | The page's path, such as `/lab`: literal segments only. A path under `/api`, a path the server answers (`/metrics`), or one a module's page already has, leaves the page unrouted and is reported in `GET /api/ui` (`UI_INVALID_PAGE`, `UI_PAGE_PATH_COLLISION`). |
| `title` | string, 1–80 characters | The page's heading (its one `h1`), and its name in the sidebar, the top bar and the document title unless `nav.label` relabels it there. |
| `icon` | icon name | Shown beside its nav entry. |
| `nav` | `{group, label?, order?}` | Its sidebar entry, `nav:ui/<id>`, in `group` (built in or new) at `order` (default 100), labelled `label` (default `title`). Without `nav` the page is routed but not listed. |
| `sections` | array, at least one | The page's sections, in reading order. |

A section is a heading over a grid of widgets: `title` (required), `columns` (1–4, default 1)
and `widgets` (at least one). Below the `md` breakpoint every section is one column. Widgets
flow left to right, then down, in the order listed, which is also the order a screen reader
reads them.

A widget:

| Key | Type | Description |
| --- | --- | --- |
| `type` | `<module>/<name>` | The widget type, provided by a module or by deck itself (the `core/…` types below). A type no module provides is `UI_WIDGET_TYPE_UNKNOWN`, and one whose module is off `UI_WIDGET_TYPE_DISABLED`; the widget then shows as unavailable and reads no data. |
| `id` | string, lowercase letters, digits and `-` | A stable name, unique on its page (`ID_DUPLICATE`). The widget's id is `widget:ui/<page>.<id>`. Without one it is positional, `widget:ui/<page>.s<N>w<M>` (section N, widget M, from 1), which **changes when sections or widgets move**: give a widget an `id` before you override it. An `id` may not take the positional form (`s1w2`). |
| `title` | string | The widget's heading; default its type. |
| `source` | provider id, or `{kind}` | The provider it reads, as `GET /api/providers` lists them; `{kind: snapshot}` takes the first provider of that kind by id. A source that names no provider, or one of a kind the widget type cannot render, is reported in `GET /api/ui` (`UI_WIDGET_SOURCE_UNKNOWN`, `UI_WIDGET_SOURCE_KIND`) and the widget shows the problem. |
| `select` | [JMESPath](https://jmespath.org) expression | What the widget shows of the provider's data. Deck evaluates it on the server each time the provider's data changes and sends the result with the provider's envelope; without `select` the widget gets the data whole. An expression that does not parse, calls a function JMESPath does not have or with the wrong number of arguments, or exceeds the size limits below is `UI_WIDGET_SELECT_INVALID`. |
| `options` | object | The widget type's options. Each type declares their schema. |
| `span` | 1–4 | Columns the widget spans from `md` up; default 1. More than its section's columns is clamped, with `UI_WIDGET_SPAN`. |
| `rows` | 1–6 | Rows the widget spans from `md` up; default 1. |

Deck's own widget types show the widget's value: its `select` result, or the provider's data
whole. Each shows what it got when the value is of a kind it cannot show ("core/stat shows a
number or text; this widget's value is a list."), so a wrong `select` is easy to spot.

| Type | Shows | Options |
| --- | --- | --- |
| `core/stat` | One number or short text, large. | `label`, `format`, `unit`, `statusMap` |
| `core/stat-grid` | Values of an object, each a stat. | `items`: `{field, label?, format?, unit?, statusMap?}`, 1–24; default the object's numbers, text and booleans, by key (the first 24) |
| `core/meter` | A number against a maximum, as a bar with its value as text. | `label`, `max` (default 100), `format` (default: the percentage of `max`), `unit`, `statusMap` |
| `core/key-value` | An object's values as label/value pairs; a value with a `statusMap` as a status badge. | `items` as for `core/stat-grid`, 1–48 (default the object's keys, the first 48); `layout`: `grid` (default), `stacked`, `inline` |
| `core/list` | A list's items as rows. An item that is text or a number is its own title. | `titleField` (default `name`), `descriptionField`, `metaField`, `metaFormat`, `statusField` and `statusMap` (a status badge), `hrefField` (a link), `limit` (1–100, default 25) |
| `core/table` | A list of objects as a table; the first column's cells are row headers. | `columns` (required, 1–12): `{field, header?, format?, unit?, align?: start\|end, statusMap?}`; `limit` (1–500, default 100) |
| `core/status-grid` | Named states as tiles, each with a status badge. The value is a list of objects, or an object of name → state. | `labelField` (default `name`), `statusField` (default `status`), `hrefField`, `statusMap`, `limit` (1–200, default 48) |
| `core/link-tiles` | Links as tiles. | `links`: `{title, href, description?, icon?}`, 1–48; without it, the value, a list of objects with those keys |
| `core/markdown` | Markdown, rendered and sanitised as the docs view does it. | `content`; without it, the value, which must be text |
| `core/health-pills` | The top bar's health pills, in its order. Reads no source. | `pills`: extension ids (`pill:drift/summary`) to show only those |
| `core/json` | The value as formatted JSON, for looking at what a source and `select` give. | `wrap: true` soft-wraps long lines |

Modules add their own types. The portal's:

| Type | Shows | Options |
| --- | --- | --- |
| `portal/groups` | The portal's groups of cards, with its search and its status and group filters. Reads no source: it reads `modules.portal.groups` and the cards' providers. | `groups`: the top-level group ids to show, in that order (1–64, unique); default every group, in the portal's order. An id no group has is skipped and reported in `GET /api/ui` (`UI_WIDGET_OPTION_UNKNOWN`). |

- A **field** (`field`, `titleField`, …) is a key of an item, or keys joined by dots
  (`load.avg`). It is never a query: shape the data with the widget's `select`, such as
  `outlets[].{name: name, watts: power.watts}`.
- A **format** is one of `text` (as given, the default), `number` (grouped digits, at most two
  decimals), `bytes` (1024-based: `1.5 GiB`), `percent` (a number of 100: `42.3%`), `duration`
  (seconds: `1h 31m`) and `relative-time` (an ISO time or epoch milliseconds: `6m ago`). A value
  the format cannot read shows as given. `unit` follows the value (`61.5 W`).
- A **link** (`hrefField`, `links[].href`) is an `http(s)` URL, which opens in a new tab, or an
  absolute path in deck (`/hosts/nas-01`). A value from data that is neither is shown unlinked.
- A **`statusMap`** names one of `ui.statusMaps`, below.

`statusMaps` maps a widget's values to status tones by name. A widget shows a toned value with
the tone's icon and the value's own text, never by colour alone, and config never names a
colour:

```yaml
ui:
  statusMaps:
    ups-load: { rules: [ { lt: 60, tone: ok }, { lt: 85, tone: warn }, { tone: danger } ] }
    outlet:   { values: { on: ok, off: neutral, fault: danger } }
  pages:
    - id: power
      path: /power
      title: Power
      sections:
        - title: UPS
          columns: 2
          widgets:
            - { type: core/stat, title: Load, source: ups, select: load_pct, options: { format: percent, statusMap: ups-load } }
            - { type: core/table, title: Outlets, source: ups, select: outlets,
                options: { columns: [ { field: name }, { field: watts, format: number, unit: W, align: end }, { field: state, statusMap: outlet } ] } }
```

A map's name is lowercase letters, digits and `-`. A map has `values`, `rules` or both:

| Key | Type | Description |
| --- | --- | --- |
| `values` | object of value → tone | Exact values. Numbers and booleans compare as their text, so `404: warn` matches the number 404. Tried first. |
| `rules` | array, 1–32 | Tried in order; the first whose every condition holds gives the tone. `lt`, `lte`, `gt` and `gte` hold for a number, or text that is wholly one (`"42"`, not `"42%"`); `eq` holds for an equal value, either way round: as numbers when either side is a number and both read as one (`0` matches `"0.0"`, `"404"` matches `404`), else as text (`true` matches `"true"`). A rule with only a `tone` matches any value, so put it last. |

A tone is one of `ok`, `warn`, `danger`, `info`, `pending` and `neutral`; anything else is a
schema error. A value no entry or rule matches shows untoned. A core widget naming a map that
`statusMaps` does not declare is `UI_STATUS_MAP_UNKNOWN` (a warning), and its values show
untoned.

A widget option its type does not accept (an unknown option, or a value of the wrong type) is a
schema error at its path, like any other invalid config: `deck validate` reports it, and deck
refuses to start with it. Omitted `options` are checked as `{}`, so a type that needs an option
needs `options`. Check a dashboard with `deck validate` before deploying it.

A `select` is bounded so that no expression can stall deck:

| Limit | Value | Past it |
| --- | --- | --- |
| Length of the expression | 1024 characters | `UI_WIDGET_SELECT_INVALID` |
| Parts of the parsed expression | 256 | `UI_WIDGET_SELECT_INVALID` |
| Multi-selects (`[a, b]`, `{a: a}`) | 8 | `UI_WIDGET_SELECT_INVALID` |
| Work per evaluation: each expression step, plus, before it is built, every list a slice, flatten or projection makes, every value an equality compares, and each function's input and output | 200 000 steps | the widget shows "Select failed" |
| Text the functions `join`, `reverse` and `to_string` build in one evaluation | 256 Ki characters | the widget shows "Select failed" |
| Values in a result | 10 000 | the widget shows "Select failed" |
| Nesting depth of a result | 64 | the widget shows "Select failed" |
| Size of a result, as JSON in UTF-8 | 256 KiB | the widget shows "Select failed" |

A select that fails or exceeds a limit at run time affects only its own widget: the provider
and the page's other widgets keep working. A select reads the data's own fields only (never
`constructor` or other built-in members), and never treats data as part of the expression. As
the JMESPath specification says, `<`, `<=`, `>` and `>=` compare numbers only; with anything
else the comparison is `null`. A slice's bounds and step are integers.

A widget shows a loading state until its provider's first data, an error when the provider
has no data because it failed or the `select` failed on its data, "No data to show" when the
value is null or an empty list or object, and a freshness badge when the data is not fresh.
A widget that fails to render shows an inline error; the rest of the page keeps working.

Overrides take a page or widget by id: `page:ui/lab: false` hides the page and its nav entry,
and `widget:ui/lab.hosts: false` hides one widget (a section left without widgets is not shown).
Overriding a positional widget id works, but `GET /api/ui` reports it as
`UI_OVERRIDE_POSITIONAL` (info).

### Hot reload

deck watches the config directory while it runs. When the directory has been quiet for a
moment, deck loads and validates the whole document again and compares it with the config it
started with:

- If only `ui` changed, the new `ui` takes effect without a restart. `GET /api/ui` serves the
  new manifest under a new `ETag`. An open page picks it up when its window regains focus, or
  within a minute.
- If the config no longer loads (a YAML error, or a finding that would stop deck from
  starting), deck keeps serving the last good config. `GET /api/ui` adds a `UI_CONFIG_INVALID`
  finding, the shell shows it in a notice, and deck logs a `config.reload` warning. The finding
  names the problem only by finding code and the path in the document (`SCHEMA_INVALID at
  /ui/brand/title`), never with a file's content or a module's own message, which could hold
  a secret. Run `deck validate` on the directory for the details.
- If anything outside `ui` changed, deck logs `restart required` and keeps serving the last good
  config, including its `ui`, until it restarts. `GET /api/ui` reports this as
  `UI_RESTART_REQUIRED`, naming the changed keys.

Fixing or reverting the edit clears the finding. Every change in the directory is noticed,
including files swapped in through temporary names or a symlinked directory, as with a
Kubernetes ConfigMap. Most changes are seen at once. Some raise no file-system event, such as a
ConfigMap re-pointing its `..data` link under Bun, which deck runs on. deck also checks the
config files every 5 seconds, so even those take effect within about 5 seconds, as do changes
on mounts that report no file events at all (some network or Docker Desktop mounts). deck also
reads the directory once more right after it starts, so an edit made while it was starting
counts. If the directory is removed or replaced, deck reports
it as missing, and within a few seconds of it coming back watches it again and reloads.

`theme` (mode, preset, density and radius) and the home page used before the manifest arrives
are written into the page when it loads. deck serves a changed value at once, but an open page
applies it on its next load.

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
