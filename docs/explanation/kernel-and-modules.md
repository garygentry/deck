# Kernel and modules

Deck is a small kernel and a set of modules that all use one contract. Every feature you see is
a module: the portal, inventory, drift, monitoring, docs and configs, actions, LLM usage, and
each kind of data source. A module you write uses the same contract as those built-ins. This
page explains how the parts fit together, and helps you choose how to extend deck. The decision
and its trade-offs are recorded in
[ADR-005](../architecture/decisions/adr-005-module-contract-and-kernel.md).

## What the kernel does

The kernel is the part every module builds on. It contains no feature of its own:

- **Config:** load the YAML layers, compose the schema from the enabled modules, merge and
  validate ([Engine and estate](engine-and-estate.md) explains the layering).
- **The module host:** read every manifest, decide which modules run, order them by their
  dependencies, start them, and stop them at shutdown.
- **The provider registry and poll scheduler:** poll every provider the modules register, cache
  the envelopes with a freshness state, and serve `/api/providers` and `/api/health` from that
  cache.
- **The HTTP app skeleton:** the core routes, the mount point each module gets, and the web
  app's fallback.
- **The UI manifest resolver:** turn every module's UI contributions, and the `ui` config, into
  the `GET /api/ui` document the web shell renders.
- **The web shell:** the sidebar, top bar, router and page registry, the shared data layer and
  the `@/ui` component library.
- **The SDKs:** `@deck/module-sdk`, the contract itself, and `@deck/sdk`, what a runtime
  module's web half builds against.

Boot, the app skeleton and the provider registry never name a feature or a provider kind: a
test (`apps/server/test/kernel-names.test.ts`) fails if they mention one. `scripts/kernel-touch.ts`
lists the kernel's files and reports which of them a change touches. Adding a built-in module
should touch only the static list of built-ins (`apps/server/src/modules/builtin.ts`), plus the
icon set (`apps/web/src/ui/lib/icons.ts`) if it needs a new icon, and a
runtime module or a sidecar touches none.

## What a module is

A module has up to three parts.

**A manifest** is plain data. The kernel can read it without running any of the module's code.
It declares:

- the module's id, version and the module API range it needs (`deckApi`);
- what switches it on (`enabledBy`) and which modules it needs first (`dependsOn`);
- the environment variables it may read;
- its config section, `modules.<id>`: a JSON Schema, which layer owns which keys, and the
  finding codes its rules report;
- the provider kinds it owns;
- what it adds to the UI: pages, nav entries, slots, extensions, widget types and icons;
- the HTTP paths it serves outside its own prefix.

The [module manifest reference](../reference/module-manifest.md) lists every key.

**A server half** is a function the kernel calls once at boot, `init(ctx)`. Everything it can
use arrives in `ctx`: its config section, a scoped logger, the env vars it declared, provider
registration, a scheduler, an HTTP sub-app at `/api/m/<id>`, a data directory and health
reporting. A data-source module also gives the kernel a handler per provider kind, which turns
the estate's `integrations[]`, `sources[]` or host and service bindings of that kind into
providers. Because everything comes through `ctx`, a module imports only types from deck.

**A web half** is a table of React components. The manifest's pages, extensions and widget
types name them. Where each component renders is not in the web half: it is in the manifest,
and the operator's `ui` config can change it.

A module may have only some of these parts. The `portal`, `inventory`, `drift` and `monitoring`
modules have no server code of their own. `metrics` has no UI.

## Data sources and features

The built-in modules come in two sorts:

| Sort | What it contributes | Built-in modules |
| --- | --- | --- |
| Data source | One provider kind: its instance schema, its handler, and how a binding of it gives a portal card a status | `link`, `http-health`, `http-json`, `remote`, `docker`, `gatus`, `prometheus`, `alertmanager`, `markdown-tree`, `file-tree`, `snapshot` |
| Feature | Pages, pills, cards and sections that read providers by id or by kind | `portal`, `inventory`, `drift`, `monitoring`, `sources`, `actions`, `llm-usage`, `metrics` |

Keeping the two apart is what lets a new data source show up in existing places. The portal reads
a card's status from whatever bindable, status-capable kind declares how. A dashboard widget
reads any provider. So a new kind needs no change to either.

## How modules start

At boot, the module host:

1. Reads every manifest, built-in and runtime. A runtime module's server entry is imported only
   while runtime modules are switched on and the module would run.
2. Composes the config schema from every installed module, switched on or not, and validates
   the estate. A section for a switched-off module is still checked: `deck validate` reports
   its problems at their real severity, and boot as advisory.
3. Works out which modules are switched on: by their config section, by an env var, or always.
4. Orders them by `dependsOn` (ties by id), and switches off a module whose dependency is off or
   that sits in a dependency cycle.
5. Registers the providers each data-source module offers, then runs each module's `init` in
   order.
6. Starts the scheduled tasks and mounts each module's routes.

A module whose problem is its own is switched off with a finding, and the rest of deck starts:

- a runtime module with a malformed manifest (`MODULE_MANIFEST_INVALID`), a module API range
  deck does not meet (`MODULE_API_INCOMPATIBLE`), a load failure or collision (`MODULE_LOAD_FAILED`) or a
  config rule that throws (`MODULE_RULE_FAILED`);
- any module whose kind handler fails while providers register (`MODULE_KIND_HANDLER_FAILED`);
- any module whose dependency is missing or switched off (`MODULE_DEPENDENCY_MISSING`), or that
  sits in a dependency cycle (`MODULE_DEPENDENCY_CYCLE`).

`GET /api/ui` lists such a module with the reason and with the setting that would switch it on.
Boot stops instead, with exit code 2, when the problem is deck's or the deployment's:

- a built-in module whose manifest, contributions, module API range or config contribution is
  unusable (`MODULE_MANIFEST_INVALID`); built-ins ship with deck, so this is a deck defect;
- two modules that cannot coexist (`MODULE_MANIFEST_CONFLICT`): a shared id, finding code,
  provider kind, health key or data directory, for example. A runtime module that claims what
  another module has is refused when it loads (`MODULE_LOAD_FAILED`, `collision`) instead, so
  it never gets this far;
- a runtime module's server entry that does not finish importing within 10 seconds, since its
  code may still be running;
- a config section that is present and invalid, for a module that runs or a runtime module that
  failed to load: you asked for the module and it cannot work;
- a built-in kind handler that reports a deployment setting deck cannot start with (a malformed
  `DECK_SNAPSHOT_SOURCE`, say);
- an `init` that throws, because the module may have done half its work.

## How the UI is assembled

Every page, nav entry, pill, card, entity-page section and widget is an **extension**. It has an
id such as `pill:drift/summary`, a slot it attaches to, an order there, and its config. The
server resolves the extensions of every running module, applies the `ui` config's overrides by
id, drops what cannot render, and serves the result as `GET /api/ui`. The web shell renders that
document and takes the components from each module's web half.

This makes the UI the operator's to arrange. The `ui` config section can rename and re-theme
deck, reorder the sidebar, hide or move any extension, pick the home page and add whole
dashboards, and it reloads without a restart. See [Customise the UI](../guides/customise-the-ui.md)
and [ADR-006](../architecture/decisions/adr-006-config-driven-ui.md).

## Where modules live

| Module | Where it lives | How deck finds it |
| --- | --- | --- |
| A built-in moved to its own package | `modules/<id>/`: `schema.json`, `server/`, `web/`, `test/server/`, `test/web/` | `apps/server/src/modules/builtin.ts` imports `server/module.ts`; the web app discovers every `modules/*/web/index.ts` |
| A built-in not yet moved | `apps/server/src/<id>/` or `apps/server/src/providers/<kind>/`, and `apps/web/src/features/<feature>/` | The same static list, and `features/*/index.ts` |
| A runtime module | `$DECK_MODULES_DIR/<id>/`: `deck-module.json`, an optional server entry, `web.js`, `web.css` | Read at boot; its code is imported only while `DECK_MODULES_ENABLED` is on |
| A sidecar | Anywhere on deck's network | A `remote` entry in `integrations[]` |

A built-in's manifest is TypeScript, not a `module.json`. The part of it the browser needs
(pages, nav entries, extensions) lives in `@deck/contract/modules/<id>`, so the web bundle never
loads server code. A runtime module ships its whole manifest as `deck-module.json`.

## Choosing how to extend deck

Start at the top of this table and go down only when the tier above cannot do what you need.
Each step down gives the extension's author more trust ([ADR-007](../architecture/decisions/adr-007-extension-tiers-and-trust.md),
[Security](../security.md#trust-tiers)).

| You want to | Use | Code? | Guide |
| --- | --- | --- | --- |
| Rename, re-theme or rearrange deck; hide or move what it shows | The `ui` config section | None | [Customise the UI](../guides/customise-the-ui.md) |
| Show values from a JSON API, coloured by meaning | An `http-json` integration and `core/…` widgets | None | [Build a dashboard without code](../guides/build-a-dashboard.md) |
| Show data that needs code: another protocol, a credential deck should not hold, another language | A sidecar (`remote` integration) | Out of process, any language | [Write a sidecar module](../guides/write-a-sidecar-module.md) |
| Add a capability to deck itself, for everyone | A module in this repository | TypeScript and React, in deck's process | [Write a module](../guides/write-a-module.md) |
| Add a capability to your own deck without rebuilding it | A runtime module | TypeScript and React, in deck's process and page | [Run a runtime module](../guides/runtime-modules.md) |

## Related reading

- [Module manifest reference](../reference/module-manifest.md)
- [`@deck/module-sdk`](../../packages/module-sdk/README.md): the server context, provider kinds,
  services, cadence and lifecycle in detail.
- [Building-block view](../architecture/building-blocks.md): the server's subsystems.
- [Web UI architecture](../architecture/ui.md): the shell, the registry and a module's web half.
