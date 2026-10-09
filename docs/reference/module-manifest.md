# Module manifest reference

A module manifest is plain JSON data that tells deck what a module is and what it adds, without
running any of the module's code. Built-in and runtime modules use the same shape,
`ModuleManifest`, defined in
[`packages/module-sdk/src/manifest.ts`](../../packages/module-sdk/src/manifest.ts). This page
lists every key. For how the parts fit together, see [Kernel and modules](../explanation/kernel-and-modules.md).
For the server context a module's code receives, see the
[`@deck/module-sdk` README](../../packages/module-sdk/README.md).

Where the manifest lives:

- **A built-in module** writes it in TypeScript and exports it from its server half
  (`defineServerModule(manifest, init, …)`). The part the browser needs, its identity and
  `contributes` without `routes` (`WebModuleManifest`), lives in
  `packages/contract/src/modules/<id>.ts`, which the server manifest spreads in and the web
  half registers. A built-in has no `module.json`.
- **A runtime module** ships it as `deck-module.json` in its directory under
  `DECK_MODULES_DIR`. The file is at most 64 KiB and nested at most 32 levels, and its `id`
  must be the directory's name. Its server entry's `manifest` and its web half's manifest must
  both equal it.

A manifest the host refuses disables its module with `MODULE_MANIFEST_INVALID`, and deck keeps
booting. Exceptions: two modules that cannot coexist fail boot (`MODULE_MANIFEST_CONFLICT`, or a
duplicate id), and so does a built-in module with an unusable manifest.

## Top-level keys

| Key | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | string | yes | Lowercase kebab-case (`^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$`), such as `llm-usage`. Its config section is `modules.<id>`, its HTTP prefix `/api/m/<id>`, and every contribution id names it. `core` and `ui` are reserved. |
| `version` | string | yes | The module's own version, shown in `GET /api/ui`. |
| `deckApi` | string | yes | The module API range the module was written for: an exact `M.m.p`, or `^M`, `^M.m` or `^M.m.p`. deck's module API is `0.1.0` (`DECK_API_VERSION`). On `0.x` the minor is the breaking part, so `^0.1` matches `0.1.*` only. A range deck does not satisfy disables the module (`MODULE_API_INCOMPATIBLE`). |
| `dependsOn` | array of module ids | no | Modules that must be enabled and started first. A missing or disabled dependency disables this module (`MODULE_DEPENDENCY_MISSING`); a cycle disables the modules in it (`MODULE_DEPENDENCY_CYCLE`). |
| `enabledBy` | `{ config?: true, env?: string }` | no | When the module runs. `config: true`: its `modules.<id>` section is present. `env`: the named variable is `true` or `1` (any case). With both, both must hold. Absent: always on. |
| `env` | array of names | no | Environment variables the module owns and may read through `ctx.env` (`^[A-Z][A-Z0-9_]*$`). A name belongs to one module: built-ins claim first, then other modules by id. A deployment setting the kernel reads (`DECK_DATA_DIR`, `DECK_PORT`, …) is refused. Put secrets here. |
| `sharedEnv` | array of names | no | Non-secret variables any module may read and none owns (`TZ`, `HTTPS_PROXY`). Never a kernel setting, a name some module owns, or a name also in `env`. |
| `envFromConfig` | array of JSON Pointers | no | Pointers into the module's own section whose string values name further variables it may read, such as `"/claude/statusLine/credentialEnv"`. A resolved name must match the env pattern, and may not be a kernel setting (unless listed in `env`) or another module's name. |
| `config` | object | no | The module's config section, `modules.<id>`; see [config](#config). |
| `providerKinds` | array | no | Provider kinds the module owns; see [providerKinds](#providerkinds). |
| `services` | `{ provides?, uses? }` | no | In-process services; see [services](#services). |
| `contributes` | object | no | UI contributions and routes; see [contributes](#contributes). |
| `health` | `{ legacyKey }` | no | `legacyKey`: a top-level `/api/health` key that mirrors the module's reported `data`, for a field that predates modules (`llmUsage`). It may not shadow a kernel field. |
| `dataDir` | `{ legacyPath }` | no | Built-in modules only: a directory directly under `$DECK_DATA_DIR` that `ctx.dataDir()` uses instead of `modules/<id>` (`actions`). One directory name, not `modules`, unique across modules. On any other module it makes the manifest invalid. |

## config

`config` declares the module's `modules.<id>` section. deck composes it into the config schema
at boot, and `deck validate` composes it the same way.

| Key | Type | Required | Description |
| --- | --- | --- | --- |
| `schema` | JSON Schema (draft 2020-12) | yes | The section's schema. It may not declare its own `$id`, anchors or dynamic references, or refer outside itself. An invalid section of a running module fails `deck validate` and boot. For a module that is switched off, `deck validate` still checks the section at real severity, while boot reports its problems only as the advisory `MODULE_SECTION_DISABLED` (see [`deck validate`](cli.md#deck-validate)). |
| `ownership` | object of key path → `base` \| `overlay` \| `both` \| `container` | no | Which config layer may set each key path, relative to the section. `""` is the whole section. Default: overlay. A value in the wrong layer is a layer finding. |
| `identity` | object of array key path → field list, or → `{ <type>: fields }` | no | The fields that pair array elements across layers, so layers merge elements by identity rather than by position (`{ "groups[]": ["id"] }`). The `{ <type>: fields }` form is for an array whose items are discriminated by a `type` field. Each row is also checked for duplicates (`ID_DUPLICATE`) unless a `unique` namespace covers it. |
| `unique` | array of `{ paths, key, message? }` | no | Id namespaces. `paths` are array key paths ending in `[]`, and one namespace may span several (`["groups[]", "groups[].items[]"]`). Elements carrying every `key` field share the namespace; a later repeat in document order is `ID_DUPLICATE`, with `message` if given (`{key}` stands for the id). When present, it lists at least one namespace. |
| `references` | array | no | Where the section names an estate host or service, resolved like the kernel's own references (`REF_HOST_UNRESOLVED`, `REF_SERVICE_UNRESOLVED`, and `OVERLAY_DANGLING_REF` in an overlay). A string is a key path whose value is `{ host, service? }`. The object form `{ path, host?, service?, at? }` names the fields (default `host`, `service`). `at: "element"` reports at the value rather than the field. |
| `findings` | array of finding codes | no | The codes the module's config rules may report: `{ code, severity, summary, fix }`. `code` is UPPER_SNAKE_CASE and unique across deck and every module; `severity` is `error`, `warning` or `info`. |

The rules themselves are code: the server half's `configRules` run over the section in every
layer and the merged document. A rule that throws or reports an undeclared code is
`MODULE_RULE_FAILED` and disables the module.

## providerKinds

Each entry declares one provider kind the module owns. A kind belongs to one module: two
modules declaring it fail boot (`MODULE_MANIFEST_CONFLICT`).

| Key | Type | Description |
| --- | --- | --- |
| `kind` | string | The kind's name (`^[a-z][a-z0-9-]*$`), as written in `integrations[].kind`, `sources[].kind` or a binding key. |
| `instanceSchema` | JSON Schema | The schema of one instance of the kind, checked together with the fields every instance has (`id`, `kind`, …). |
| `instanceList` | `integrations` \| `sources` | The list `instanceSchema` applies to; default `integrations`. |
| `static` | boolean | Fetched once at registration and never polled (`link`). A static kind cannot have an `instances` handler or a cadence. |
| `bindable` | boolean | May appear in `hosts[].bindings` and `services[].bindings`. The server half must then handle it (`kinds[kind].binding`). A binding of a kind that is not bindable is ignored and reported (`PROVIDER_BINDING_UNSUPPORTED`, info). |
| `statusCapable` | boolean | Its data can drive a status tone. |
| `status` | object | Only on a `bindable`, `statusCapable` kind: how a binding gives a portal card its up or down status, as data the web reads (see below). |
| `findings` | array of finding codes | The codes the kind handler's `validate` rule may report. |
| `fixedId` | string | Built-in modules only: the fixed, public provider id the kind's instances register under (`prometheus`, `docker`, `gatus`). Config validation reserves it (`PROVIDER_ID_RESERVED`). |
| `fixedIdEnv` | string | Built-in modules only, with `fixedId`: a variable whose non-empty value registers the fixed id with no instance (`snapshot`'s `DECK_SNAPSHOT_SOURCE`). |

`status` has three keys:

- `provider`: `binding` reads the provider the kind's binding handler registers under the
  binding's own id (`http-health`). `fixed` reads the kind's `fixedId` instance, shared by every
  binding (`docker`); it is honoured for built-in modules only.
- `match` (optional): `{ list, key, binding }` finds the bound item. It is the element of the
  list at key path `list` whose `key` field equals the binding's `binding` field (`{ list:
  "containers", key: "name", binding: "container" }`). Without `match`, the provider's data is
  the item.
- `up`: 1–8 conditions `{ field, in }`, each a key path and 1–32 text, number or boolean
  values. The item is up when every condition holds, else down.

A kind that is bindable and status-capable but declares no `status` is reported in
`GET /api/ui` (`UI_STATUS_UNDECLARED`), and its bindings give cards no status.

The handlers (`binding`, `instances`, `validate`) are code, on the server half's `kinds`; see
[Provider kinds](../../packages/module-sdk/README.md#provider-kinds) in the SDK README.

## services

| Key | Type | Description |
| --- | --- | --- |
| `provides` | array of names | Services the module may offer with `ctx.services.provide`. |
| `uses` | array of names | Services the module may read with `ctx.services.get`. It starts after every running module that provides them. |

A name is `<namespace>/<name>` in lowercase kebab-case, at least two segments
(`sources/reader`). One module never both provides and uses a name. See
[Services](../../packages/module-sdk/README.md#services).

## contributes

| Key | Type | Description |
| --- | --- | --- |
| `pages` | array | Pages the shell routes; see [pages](#pages). |
| `nav` | array | Sidebar entries; see [nav](#nav). |
| `slots` | array | Slots the module hosts, which other modules' extensions can attach to; see [slots](#slots). |
| `extensions` | array | Pills, cards, entity sections and top-bar actions; see [extensions](#extensions). |
| `widgetTypes` | array | Widget types dashboards may use; see [widgetTypes](#widgettypes). |
| `icons` | object of name → SVG | Runtime modules: icons named `<id>/<name>`, at most 64 of at most 16 KiB each, each an `<svg xmlns="http://www.w3.org/2000/svg">` document with no styles, scripts or external references. Pages, nav entries, components and `ui.brand.icon` use them by name. Built-ins use the web's icon registry instead. See [Run a runtime module](../guides/runtime-modules.md#add-a-web-half) for the rules. |
| `routes` | object | Server-only paths; see [routes](#routes). Not part of the web half's manifest. |
| `statusMaps` | object | Declared in the type, but deck does not read it: dashboards' status maps come from `ui.statusMaps`. |

Every contribution id has the form `<kind>:<module>/<name>` and names the module itself: `<kind>`
is lowercase, `<module>` is the module id, and `<name>` is lowercase letters, digits, `.` and `-`.
Pages use the `page:` prefix and nav entries `nav:`, and nothing else may. An `order` is a finite
number, and an omitted one counts as 100.

### pages

| Key | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | `page:<module>/<name>` | yes | |
| `path` | string | yes | The route, starting with `/`: literal segments and `:param` segments (`/hosts/:name`), which the web router must be able to compile. Not under `/api` or `/modules`, and not a root path the kernel or a built-in serves (`/metrics`). A page on another module's root path, or on a path an earlier page has, is not routed (`UI_PAGE_PATH_COLLISION`). No page may declare `/`, which renders the home page. |
| `title` | string | yes | The page's heading and, by default, its nav label. |
| `icon` | icon name | no | Shown beside its nav entry. |
| `component` | string | yes | The name of the component in the web half's table. `ConfigPage` is the kernel's. |
| `layout` | `{ sections }` | no | The page's default dashboard, which its component renders with the shell's layout helpers. 1–16 sections, each `{ slot }` (a `widget` slot the module hosts) or `{ widgets }`: 1–24 `{ id, type }`, of the module's own widget types or core's, with no options or source. A type whose options schema refuses `{}` is refused. Each widget is `widget:<module>/<page name>.<id>`, which an override can switch off. |

### nav

| Key | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | `nav:<module>/<name>` | yes | A page's entry takes the page's name (`nav:drift/overview` for `page:drift/overview`): the web half refuses any other, and at most one entry per page. |
| `page` | page id | one of `page`, `href` | The page the entry opens. |
| `href` | string | one of `page`, `href` | An `http(s)` URL or an absolute path in deck (not `//…`). The web half cannot register an `href` entry; it is the server's to list. |
| `group` | string | yes | A nav group id (lowercase letters, digits and `-`): built in (`overview`, `inventory`, `health`, `operate`, `knowledge`) or new. |
| `label` | string | no | Default: the page's title. |
| `icon` | icon name | no | Default: the page's icon. |
| `order` | number | no | Position within the group. Built-in entries are 100; the portal is -1. |

### slots

| Key | Type | Description |
| --- | --- | --- |
| `id` | string | `<module>/<name>`, namespaced to the module (`portal/summary`). The `app/…` and `entity:…` namespaces belong to `core`. |
| `accepts` | `pill` \| `widget` \| `entity-section` \| `nav` \| `page` \| `action` | The one extension kind the slot takes. |

`core` hosts these slots, which any module can attach to:

| Slot | Accepts | Where it renders |
| --- | --- | --- |
| `app/nav`, `app/routes` | `nav`, `page` | The sidebar and the router |
| `app/topbar.status` | `pill` | The top bar's health pills |
| `app/topbar.actions` | `action` | The top bar's controls (the theme menu, `action:core/theme-menu`) |
| `entity:host/sections`, `entity:service/sections` | `entity-section` | Host and service detail pages |

The portal hosts `portal/summary` (`widget`): cards above its groups.

### extensions

| Key | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | `<kind>:<module>/<name>` | yes | Any prefix but `page:` and `nav:`. The built-ins use `pill:`, `card:`, `section:` and `action:`. |
| `kind` | `pill` \| `widget` \| `entity-section` \| `action` | yes | Must be what its slot accepts (`UI_SLOT_KIND_MISMATCH` otherwise). |
| `attachTo` | `{ slot, order? }` | yes | The slot, and the order within it. A slot no module declares is `UI_UNKNOWN_SLOT`. |
| `component` | string | see below | The component in the web half's table. Required, except for a widget descriptor. |
| `widget` | object | no | A widget descriptor instead of a component. deck accepts it and lists it in `GET /api/ui`, but no slot host renders descriptors yet. |
| `config` | object | no | Given to the component. An `entity-section` requires `title` (its heading) and may name a shared `section` (lowercase `a-z 0-9 -`, no `.`); without one, the extension has its own section, `<module>.<name>`. |
| `enabled` | boolean | no | Default `true`. A `false` extension stays off unless `ui.extensions` enables it. |

### widgetTypes

| Key | Type | Required | Description |
| --- | --- | --- | --- |
| `type` | `<module>/<name>` | yes | Namespaced to the module; listed once. |
| `optionsSchema` | JSON Schema | yes | The widget's `options`. Config validation checks every widget of the type against it. |
| `component` | string | no | The component in the web half's table. It receives `WidgetProps`: `value`, `options`, `freshness`, the placed `widget` and its `placement`. |
| `sources` | array of provider kinds | no | The kinds the type can render. A widget of the type over another kind is `UI_WIDGET_SOURCE_KIND`. |
| `optionReferences` | array of `{ option, list, key }` | no | Options whose values name entries of the module's own section: each value of `option` should be the `key` of an entry of `modules.<id>.<list>`. A value with no entry is `UI_WIDGET_OPTION_UNKNOWN` (a warning), and the widget skips it. |

The [widget types reference](widget-types.md) lists the types deck and its built-ins provide.

### routes

| Key | Type | Description |
| --- | --- | --- |
| `legacyAliases` | array of paths | Extra prefixes the module's `/api/m/<id>` sub-app is also mounted at, for paths that predate the module (`/api/llm-usage`). Literal paths (`A-Z a-z 0-9 . _ ~ - /`) under `/api/`, outside `/api/m`, overlapping no other prefix or kernel route. |
| `rootPaths` | array of paths | Exact literal paths outside `/api` the module serves with `ctx.rootRoute` (`/metrics`). The web app's fallback never answers them, even while the module is off. A root path a built-in declares, or one a built-in or kernel page path matches, is refused. |
| `whenDisabled` | array of `{ method, path, status, body }` | Fixed JSON answers at the module's prefixes while it is installed but not running, so a client can learn the capability is off. `method` is `GET`, `POST`, `PUT`, `PATCH` or `DELETE`; `path` is `""` or `/`-separated literal and `:param` segments; `status` 200–599. No module code runs for them. Without them, those paths answer 404. |

## Example

The built-in `llm-usage` module's manifest, the UI part from
`packages/contract/src/modules/llm-usage.ts` spread into the server's:

```ts
export const LLM_USAGE_UI: WebModuleManifest = {
  id: "llm-usage",
  version: "1.0.0",
  deckApi: "^0.1",
  contributes: {
    pages: [{ id: "page:llm-usage/overview", path: "/usage", title: "LLM usage", icon: "gauge", component: "LlmUsagePage" }],
    nav: [{ id: "nav:llm-usage/overview", page: "page:llm-usage/overview", group: "health" }],
    extensions: [
      { id: "pill:llm-usage/summary", kind: "pill", attachTo: { slot: "app/topbar.status", order: 40 }, component: "LlmUsageSummary" },
      { id: "card:llm-usage/portal", kind: "widget", attachTo: { slot: "portal/summary" }, component: "LlmUsagePortalCard" },
    ],
  },
};

export const LLM_USAGE_MANIFEST: ModuleManifest = {
  ...LLM_USAGE_UI,
  contributes: { ...LLM_USAGE_UI.contributes, routes: { legacyAliases: ["/api/llm-usage"] } },
  envFromConfig: ["/claude/statusLine/credentialEnv"],
  config: { schema, ownership: { "": "overlay" }, findings: [LLM_USAGE_INVALID] },
  health: { legacyKey: "llmUsage" },
};
```

A runtime module's `deck-module.json` has the same keys. See
[`examples/modules/hello/deck-module.json`](../../examples/modules/hello/deck-module.json).

## See also

- [Write a module](../guides/write-a-module.md) and [Run a runtime module](../guides/runtime-modules.md)
- [`@deck/module-sdk` README](../../packages/module-sdk/README.md): the server context, the
  lifecycle, provider kind handlers and UI resolution.
- [HTTP API reference: UI manifest](http-api.md#ui-manifest): how contributions appear in
  `GET /api/ui`.
- [ADR-005](../architecture/decisions/adr-005-module-contract-and-kernel.md)
