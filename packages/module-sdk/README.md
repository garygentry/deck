# @deck/module-sdk

The contract between deck's kernel and its modules. Built-in features and external modules
use the same contract.

A module has three parts:

- **Manifest.** Plain JSON data (`ModuleManifest`). The kernel reads it without running any
  module code. It declares:
  - the module's id, version and `deckApi` range;
  - how the module is enabled (`enabledBy`), its dependencies (`dependsOn`), and the env vars
    it may read;
  - its config schema, provider kinds and UI contributions.
- **Server half.** A `{ manifest, init }` object; `init` receives a `ServerModuleContext` with
  every service the module may use. `defineServerModule(manifest, init)` builds one, but it is
  a convenience: a plain object works the same, so module code can import only *types* from
  this package and nothing from deck is resolved at runtime.
- **Web half.** `defineWebModule(manifest, { components })`. This is a table of components
  that the manifest's pages, extensions and widget types refer to by name. It reads only the
  manifest's identity and `contributes` (`WebModuleManifest`), so a full manifest works, and a
  built-in shares just that part with the web (`@deck/contract/modules/<id>`).

## Server module context

Services marked *init only* belong in `init`. Called later from inside one of the module's
own request handlers, they throw (the request fails with a 500). Called later from anywhere
else (a timer, a detached promise), where a throw would crash the process, they log
`<id>.late-registration` and return an inert handle (or, for `rootRoute`, do nothing).

| Service | What it does |
|---|---|
| `config` | The module's `modules.<id>` section, or `undefined` when absent |
| `logger` | A structured logger. Every line carries `module: <id>`. Event names are open, so prefix them with the module id (`llm-usage.poll`) |
| `clock` | `now()`, injectable in tests |
| `env.get(name)` | Reads only the names listed in `env`, plus names that config holds at the `envFromConfig` pointers. The names in `env` are the module's own: no other module may declare them, and none may be a deployment setting the kernel itself reads (`DECK_DATA_DIR`, `DECK_SNAPSHOT_SOURCE`, …). Names in `sharedEnv` (`TZ`, `HTTPS_PROXY`) are readable by every module that lists them and owned by none; they must not be a kernel setting or a name some module owns. A name a built-in module lists in `sharedEnv` (`DECK_SOURCES_CACHE_DIR`) is the built-ins' setting: another module declaring it in `env` is refused. **Secrets belong in `env`**, where only the owning module can read them. A config-resolved name must match `^[A-Z][A-Z0-9_]*$` and be neither a kernel setting nor another module's name. Every other name reads as `undefined` |
| `providers.register(provider, options)` | Init only. Registers a provider with the kernel registry, served at `/api/providers/<id>`. It polls once as soon as polling starts; an optional `cadence` then replaces the fixed `pollIntervalMs`. A static provider cannot take a cadence |
| `providers.stats()` | Every registered provider's poll statistics in id order (kind, success and failure counts, the latest poll's latency, the cached data's age), read from the kernel's cache with no upstream I/O. Callable at any time, by any module: it carries no provider data or credentials, only poll bookkeeping beside the ids, kinds and data ages `/api/providers` already serves |
| `scheduler.schedule({ name, run, cadence })` | Init only. A background task on an adaptive cadence that is not exposed as a provider. Tasks start once every module has initialised |
| `http` | A Hono sub-app mounted at `/api/m/<id>` and at every `contributes.routes.legacyAliases` prefix |
| `rootRoute(path, handler)` | Init only. Serves an exact path outside `/api`, which must be declared in `contributes.routes.rootPaths`. The SPA fallback never rewrites a declared root path, even while the module is disabled |
| `dataDir()` | `$DECK_DATA_DIR/modules/<id>` (or `$DECK_DATA_DIR/<dataDir.legacyPath>`, for a built-in module's data that predates modules; another module declaring `dataDir` is invalid), created on first call. Throws a classified error if `DECK_DATA_DIR` is unset or relative, or the directory cannot be created. A module that never calls it boots without the variable |
| `services.provide(ref, impl)` / `services.get(ref)` | Init only (`provide`). In-process services shared between modules; see [Services](#services) |
| `instances(list)` | The estate's `integrations[]` or `sources[]` declarations, as frozen copies in document order. They name credential variables, never hold their values (`/api/config` serves the same document) |
| `health.report(fn)` | Feeds `/api/health.modules[<id>]`. With `health.legacyKey`, the reported `data` is also mirrored at that top-level key. A report that throws, or whose `detail` or `data` is not JSON, shows as the module's error entry. Module health never changes the overall `status` |
| `onStop(fn, options?)` | Teardown hooks. At shutdown the module's tasks and providers are stopped and their in-flight runs drained first, for at most a bounded time (deck's shutdown allows 2s; a run still going is logged as `<id>.stop-timeout`). Then the hooks run in reverse order, each for at most a bounded time (deck's shutdown allows 1s; a hook still running is abandoned and logged as `<id>.stop-hook-timeout`). A failing hook is logged and does not block the rest. With `{ early: true }` a hook instead starts the moment shutdown begins, beside every module's ordinary stop; `timeoutMs` replaces the per-hook bound. Every hook's bound is clamped to what is left of the whole module stage (4s in deck's shutdown), so a hook is abandoned, and logged, before the stage gives up |

### Provider kinds

A data-source module declares each provider kind it owns in `providerKinds` (with the flags
`static`, `bindable` and `statusCapable`, and optionally an `instanceSchema` for its
`integrations[]` or `sources[]` entries), and handles it in the server half's `kinds`:

```ts
defineServerModule(manifest, init, {
  kinds: {
    feed: {
      // One host or service binding of the kind: `id` is the binding's own id, or `<kind>:<owner>`.
      binding: ({ id, owner, value }, { env }) => [{ provider: new FeedProvider(id, value, env) }],
      // Every instance of the kind, in document order; envFor(i) can also read i's credentialEnv.
      instances: (instances, { envFor }) => instances.map((i) => ({ provider: new FeedProvider(String(i.id), i, envFor(i)) })),
    },
  },
});
```

The kernel calls the handlers while registering providers, before any `init` runs, and
registers the offered providers (a `static` kind's are fetched once and never polled); they stop
with the module. A handler may return no offers, for a binding that only selects from another
provider's data. The handler context's `env` reads the manifest's `env` (and `sharedEnv`) names
only, and a binding carries the same reader as `binding.env`. `envFor(instance)` adds the
`credentialEnv` that one instance names, but only for the instance objects the kernel passed to
`instances` (frozen copies); an object the handler builds or copies unlocks nothing. A kernel
setting or a name another module owns is never unlocked. So a provider only ever sees the
credential of the instance it was built from. The context's `logger` is the module's scoped
logger (every line carries `module: <id>`), for handlers that report what they drop.

The context's `estate` is the validated estate document, deep-frozen: the same document
`/api/config` serves, so it names credential variables but never holds their values. It is for a
provider that reads the estate as a whole; the `snapshot` provider, for one, validates each
snapshot against the declared hosts and services. In-process modules are fully trusted, so this
widens nothing they could not already read.

A handler may also carry `validate(instance, { layer, document, fixedIds })`: a pure config check over one
`integrations[]` (or `sources[]`) instance of its kind, for what the instance schema cannot
express (a URL the runtime parser rejects, say). It runs on the merged document of every
validation, before any module code initialises, for each instance of the kind in document order.
Each finding's `path` is relative to the instance, and its `code` must be one the kind's
declaration lists in `findings` (with severity, summary and fix, as a config section's codes
are). `document` is the merged document, read-only, and `fixedIds` maps each built-in kind that
declares `fixedId` (the provider id its instances register under) to that id. A rule that throws
or reports an undeclared code is `MODULE_RULE_FAILED`, and disables the module that owns the kind.

Each offered provider must be of the handler's own kind. A provider that keeps its binding's or
instance's own id follows the estate: a duplicate fails boot (`PROVIDER_DUPLICATE_ID`) as it
always has. An id the module chooses itself must not be taken by any other provider. A built-in
module's `instances` offer marked `fixedId: true` (a fixed, public id clients address literally,
such as `prometheus`, `docker` or `gatus`) reserves its id the same way: another estate provider with that id fails
boot with `PROVIDER_DUPLICATE_ID`. `fixedId` is a built-in-only privilege and applies to
`instances` offers only: it is ignored on binding offers, and another module's offer carrying it
is treated as module-chosen.

A handler that throws, returns anything but a list of offers (each with a provider that has
`id`, `kind`, `fetch` and `health`), offers another kind, or offers a module-chosen id that is
otherwise taken (unless it is a built-in's `fixedId`), disables its module with `MODULE_KIND_HANDLER_FAILED`: none of that module's providers are
registered, and deck keeps booting.

A built-in module's handler may instead throw `BootFatalError` for a deployment setting deck cannot
start with (a malformed `DECK_SNAPSHOT_SOURCE`, say): boot then fails with its message on stderr
and exit code 2, as for an invalid estate config, so keep the message free of secrets. This is a
built-in-only privilege, like `fixedId`: any other module that throws `BootFatalError` is disabled
like any other failing handler, and deck keeps booting.

The module is disabled with `MODULE_MANIFEST_INVALID` when a `bindable` kind has no `binding`
handler, a handler names a kind the manifest does not declare, a kind is declared twice, or a
`static` kind has an `instances` handler. Two modules declaring one kind fail boot
(`MODULE_MANIFEST_CONFLICT`), whether through config loading or the module host alone. A
binding of a declared kind that is not `bindable` is ignored and reported as `PROVIDER_BINDING_UNSUPPORTED` (info).

A handler's context also carries `services.provide`, so a data source can offer a service
built from its instances (a reader over the stores its providers use); see [Services](#services).

### Services

Modules share in-process objects through named services, scoped to one running module host.
The manifest declares them, so the host can order modules without running their code:

```ts
manifest.services = { provides: ["sources/reader"] }; // a module that offers it
manifest.services = { uses: ["sources/reader"] };     // a module that reads it

const SOURCE_READER: ServiceRef<SourceReader> = { name: "sources/reader" }; // or serviceRef<T>(name)
ctx.services.provide(SOURCE_READER, reader);            // init only (or a kind handler's context)
for (const reader of ctx.services.get(SOURCE_READER)) …  // every running provider's offer
```

- A name is `<namespace>/<name>` in lowercase kebab-case. One module never both provides and
  uses a name. A malformed declaration makes the manifest invalid.
- `provide` and `get` throw for a name the manifest does not declare.
- A module that uses a name initialises after every module that provides it. This only orders
  them: a use needs no provider, and `get` returns an empty list when none is running. A cycle
  through `dependsOn` and service edges disables the modules in it, except that a service edge
  never puts a built-in module in a cycle: the non-built-in module on that edge is refused
  (`MODULE_MANIFEST_INVALID`, naming the service), and the built-ins plan normally.
- `offers(ref)` returns the same offers with who made them (`module`, `builtin`, the module's
  `providerKinds`), so a user can rank them. The sources module answers a declared source only
  from the reader of the module owning its kind, and an undeclared id from a built-in reader
  first, then from the single non-built-in reader that serves it.
- An offer becomes visible once its module has started (its `init` returned). The offers of a
  module that never starts (a kind handler failed, `init` threw, it is disabled) are never
  visible. `get` returns offers in init order.
- When the host stops, or a module's init fails, every offer is released: nothing a module
  offers outlives its host.
- The service's interface is a type the defining module exports (the sources module exports
  `SourceReader`). A module that imports only types from this SDK can still implement it
  structurally and offer it.

### Cadence

A cadence hook returns the delay in ms until the next run, or `null` to pause:

```ts
type Cadence = (s: { now; lastRunAt; lastOk; consecutiveFailures }) => number | null;
```

The next run is due at `now + delay` after each run. The hook is asked again:

- on every `wake()`, which can bring the due time forward but never postpone it;
- when the due time arrives, where a `null` answer skips that run.

Due times are absolute, so a very long delay never fires early. `runNow()` runs immediately
and joins a run that is already in flight, including from inside the run itself. Runs never
overlap. A run that throws counts as a failure; the task keeps going. `stop()` is terminal
and resolves once a run in flight has finished; called from inside that run (a task stopping
itself), it resolves at once rather than waiting for itself.

### Provisional: `ctx.http` is a Hono app

`ctx.http` exposes Hono's own type, so a module can use Hono middleware such as `bodyLimit`.
This leaks the host's HTTP framework into the module API. It stays provisional until the
module API freezes at `deckApi` 1.0, and it may be replaced by a narrower router type then.

An error response uses deck's envelope, built with `apiErrorBody(error, code?)`
(`{"error": …, "code": …}`), the same helper the kernel's routes use.

## Lifecycle

The kernel's module host goes through these steps:

1. **Snapshot and validate every manifest.** Planning reads a frozen JSON copy, never the
   original; a getter is rejected without being called.
   - A defect in one module's own manifest (a bad id, a non-JSON value, a malformed env name,
     alias or root path) disables that module with a `MODULE_MANIFEST_INVALID` finding. So does
     a prefix or root path that a kernel route could match (parameterised routes included), a
     root path a built-in module declares (`/metrics`, say), or a root path a built-in or
     kernel page path matches (`/hosts/gov` against `/hosts/:name`). This is checked before the
     module runs, whether or not it is enabled, and a refused module reserves nothing.
   - Modules that cannot coexist fail boot: two well-formed manifests with the same id, a
     shared `legacyKey` or `dataDir.legacyPath`, overlapping legacy aliases, or a root path
     shared by two modules that are not built in.
   - Env names are owned. A manifest whose `env` or `sharedEnv` lists a kernel setting is
     invalid. Once the compatibility, dependency and cycle refusals are made, each `env` name
     goes to the first module that could run and declares it, built-in modules first and then
     by id. A later module declaring it, or listing it in `sharedEnv`, is disabled with
     `MODULE_MANIFEST_INVALID`. A refused module owns nothing.
   - Aliases and root paths are literal paths (`A-Z a-z 0-9 . _ ~ - /`): aliases under `/api/`
     outside `/api/m`, root paths outside `/api`.
   - The id `core` is reserved for the kernel, which hosts the shell's slots under it.
   - UI contributions (`pages`, `nav`, `slots`, `extensions`) must be well formed. A malformed
     contribution disables the module like any other manifest defect:
     - Ids have the form `<kind>:<module>/<name>` and name the module itself. Pages use `page:`
       and nav entries use `nav:`; an extension may use neither.
     - An extension's `kind` is one of `pill`, `widget`, `entity-section` or `action`, and it
       names its `attachTo.slot`.
     - A slot id is namespaced to its module (`<module>/<name>`). The `app/…` and
       `entity:<entity>/…` namespaces belong to the kernel.
     - An `entity-section` extension's `config` has a `title` (its section's heading) and may
       name a `section` (lowercase `a-z 0-9 -`, no `.`) that it shares with any other extension
       naming it. Without one, the extension has its own section, `<module>.<name>` from its id
       (`entitySectionName`), which cannot be joined: dotted names are reserved for it. The entity pages render every section attached to them, in order.
     - A page path starts with `/`, and is not under `/api` or on a root path the kernel or a
       built-in module serves (`/metrics`, listed in `BUILTIN_ROOT_PATHS`). A page on any other
       module's declared root path is not routed, since that path always belongs to the server
       (running or not): the UI resolver drops it with a `UI_PAGE_PATH_COLLISION` finding.
     - A nav entry targets exactly one of a page id or an `href`, and an `href` is an
       `http(s):` URL or an absolute path (not `//…`).
2. **Work out which modules are enabled:**
   - `enabledBy.config` requires the `modules.<id>` section to be present.
   - `enabledBy.env` requires the variable to be `true` or `1`.
   - When both are given, both must hold. A module with no `enabledBy` is always on.
3. **Order modules by `dependsOn`.** Ties break by id.
4. **Disable, with a warning finding:**
   - a module whose `deckApi` range the kernel does not satisfy (`MODULE_API_INCOMPATIBLE`);
   - a module whose dependency is missing or not enabled (`MODULE_DEPENDENCY_MISSING`);
   - an enabled module in or downstream of a dependency cycle (`MODULE_DEPENDENCY_CYCLE`).
5. **Run each enabled module's `init` in order.** If an init throws, the modules already started
   are stopped and boot exits 2.
6. **Start the scheduled tasks, then mount the routes.** Mounting re-checks module paths
   against the live kernel route table as a backstop, so a kernel route never silently
   shadows a module.
   A module that is installed but not running (switched off, or refused at step 4) mounts
   only its declared `contributes.routes.whenDisabled` answers at its prefixes, if any; no
   module code runs for them.

## Config section

A module that owns a `modules.<id>` section declares it in `config`, as data the kernel
composes into the config contract:

- `schema`: the section's JSON Schema (draft 2020-12).
- `ownership`: which layer owns which key paths, relative to the section (default overlay).
- `identity`: the fields that pair array elements across layers, either a field list or, for
  an array discriminated by `type`, `{ <type>: fields }`. Each row is also checked for
  duplicates (`ID_DUPLICATE`), unless a `unique` namespace covers its array.
- `unique`: id namespaces, `{ paths, key, message? }`. `paths` are array key paths ending in
  `[]`, and one namespace may span several of them (`["groups[]", "groups[].items[]"]`).
  Elements carrying every `key` field as an own property share the namespace. A later
  occurrence in document order is `ID_DUPLICATE`, with `message` if given (`{key}` stands for
  the id, inserted literally). The identity row of an array a namespace covers only keys the
  merge. An empty `unique` list is invalid.
- `references`: where the section names an estate host or service (not to be confused with a
  widget type's `optionReferences`, under [UI contributions](#ui-contributions)), resolved like the
  kernel's own references (`REF_HOST_UNRESOLVED`, `REF_SERVICE_UNRESOLVED`, and
  `OVERLAY_DANGLING_REF` against an overlay's base). A string is a key path whose value is
  `{ host, service? }`. The object form `{ path, host?, service?, at? }` names the fields
  (default `host` and `service`). With `at: "element"`, a finding points at the value itself
  rather than at the field. A value without a string host field is not a reference.
- `findings`: the codes the module's config rules may report. The rules themselves are code,
  so they live on the server module (`configRules`), not in the manifest.

A malformed declaration makes the module's manifest invalid (`MODULE_MANIFEST_INVALID`), and
the module is disabled.

## UI contributions

The kernel resolves every enabled module's `contributes.pages`, `nav`, `slots` and
`extensions` into the UI manifest served at `GET /api/ui` (type `UiManifest`, exported from
this package as a type). Resolution reads manifests only:

1. Collect the contributions of every enabled module, with their declared defaults. An
   extension declared `enabled: false` stays off unless an override enables it. Where two
   claim the same id, slot or page path, the **incumbent keeps it**: `core` first, then the
   features still wired into the kernel and the built-in modules, then other modules, each by
   id. The newcomer gets a finding.
2. Apply overrides by id. Overrides come from the `ui.extensions` map of the `ui` config
   section, which config cannot set yet; until it can, nothing is overridden. They replace and
   never merge:
   - `false` disables an extension, page or nav entry, and disabling a page also removes the
     nav entries to it;
   - an object replaces an extension's `attachTo` and `config` wholesale, and a nav entry's
     `attachTo` (by default `app/nav`). In a replacement `attachTo`, an omitted `slot` keeps the
     slot and an omitted `order` is the default.
   An override takes only what applies to its target: a page `enabled`, a nav entry `enabled`
   and `attachTo`, an extension also `config`. A malformed override is ignored with
   `UI_INVALID_OVERRIDE`. A replacement `config` that is not a usable entity section (no `title`,
   or a dotted `section`) gets the same finding, but only the config is dropped: the rest of the
   override, such as `enabled: false`, still applies.
3. Drop what cannot render: contributions of disabled modules, and anything attached to a slot
   whose module is disabled.
4. Report problems as `findings` rather than failing:
   - `UI_UNKNOWN_EXTENSION`: an override for an unknown id, or a nav entry to an undeclared page;
   - `UI_UNKNOWN_SLOT`: an attachment to an unknown slot;
   - `UI_SLOT_KIND_MISMATCH`: an attachment to a slot that does not accept the contribution's
     kind;
   - `UI_PAGE_PATH_COLLISION` and `UI_DUPLICATE_ID`: the losing side of a contested path, id or
     slot;
   - `UI_INVALID_OVERRIDE`: a malformed override.
5. Sort pages by id, nav entries by group, order and id, and extensions by slot, order and
   id. An order that is not declared counts as 100. A nav entry's `order` applies within its
   group. The groups are listed in `navGroups`, in sidebar order: the groups the ui config
   names, in its order and with its labels, then any other group an entry uses, by id and
   headed by its id. A nav entry with no `label` or `icon` of its own takes its page's title and
   icon. `brand.title` is the estate's `estate.name`, or "Deck" when that is empty.

The rules themselves are exported as pure functions (`extensionIdProblem`, `slotIdProblem`,
`orderProblem`, `pagePathProblem`, `entitySectionProblem`, `entitySectionName`, `isSafeHref`, …),
so the web registry checks registrations exactly as the server checks manifests.

A widget type (`contributes.widgetTypes[]`: `type`, `optionsSchema`, `component`, `sources`)
may also declare `optionReferences`, `[{ option, list, key }]`: options whose values (text, or a
list of text) name entries of the module's **own** config section, each the `key` of an entry of
`modules.<id>.<list>`. The portal's `portal/groups` declares `{ option: "groups", list:
"groups", key: "id" }`. A value no entry has is reported in the UI manifest
(`UI_WIDGET_OPTION_UNKNOWN`, a warning) and the widget skips it. Contrast the config section's
`references` (above): those resolve **estate hosts and services** named in the section itself,
as config findings (`REF_HOST_UNRESOLVED`, …); `optionReferences` resolve a widget's
**options** against the module's own section, as UI findings. A malformed list makes the
manifest invalid.

`core` hosts the slots `app/nav` (nav entries), `app/routes` (pages), `app/topbar.status`
(pills), `app/topbar.actions` (actions; the theme menu, `action:core/theme-menu`, is one),
`entity:host/sections` and `entity:service/sections` (entity sections). Modules host
slots of their own under their id, for example `portal/summary` (widgets).

## Versioning

`DECK_API_VERSION` is the kernel's module API version. `satisfiesDeckApi(range)` accepts these
ranges:

- an exact version, `M.m.p`;
- `^M`, `^M.m` and `^M.m.p`.

On `0.x`, a minor bump is breaking, so `^0.1` matches `0.1.*` only. On `0.0.x` every
release is breaking, so `^0.0.3` matches `0.0.3` only.
