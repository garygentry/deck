# ADR-005: One module contract for every feature, around a small kernel

- Status: accepted
- Date: 2026-10-09

## Context

Up to v0.3, the estate's *facts* were config-driven (ADR-002), but deck's own *shape* was not.
Every feature was wired into the server and the schema by name:

- boot registered each feature's providers and routes;
- the config schema had one top-level key per feature (`groups`, `actions`, `llmUsage`);
- a fixed list of provider kinds had to be kept in step with the providers;
- the web registered pages and nav entries from constants in each feature.

Adding the LLM usage feature showed the cost. It touched boot, the app skeleton, the API
contract, layer ownership in the schema library and the web shell, besides its own directory.
There was also no way to add a capability deck's authors had not foreseen without forking.

A plugin API that only third parties use tends to rot: the built-ins never stress it, so it
lacks what real features need. Backstage and VS Code avoid that by building their own features
on their public API.

## Decision

Reshape deck into a **small kernel plus modules on one contract**, and put every built-in feature
on that contract. The contract is `@deck/module-sdk` (`packages/module-sdk`).

**A module is a manifest, plus optional code.** The manifest (`ModuleManifest`) is plain JSON
data. It declares:

- the module's id, version and `deckApi` range;
- how it is enabled (`enabledBy`), its dependencies (`dependsOn`) and the env vars it may read;
- its config section (`config`: schema, layer ownership, identity, finding codes, references);
- its provider kinds (`providerKinds`) and in-process services (`services`);
- its UI contributions (`contributes`: pages, nav entries, slots, extensions, widget types,
  icons, routes);
- its health and data-directory needs.

The kernel validates config, plans which modules run, builds the nav and lists what is installed
**without running module code**. The server half is `{ manifest, init, configRules?, kinds? }`.
`init` receives a `ServerModuleContext` that injects every service a module may use:

- `config`, `logger`, `clock`;
- `env` (only declared names);
- `providers.register`, `scheduler` (with an adaptive cadence);
- `http` (a sub-app at `/api/m/<id>`), `rootRoute`;
- `dataDir()`, `services`, `instances()`;
- `health.report`, `onStop`.

Because everything arrives through `ctx`, module code imports only *types* from deck. The web
half is a component table (`defineWebModule(manifest, { components })`) that the manifest's
pages, extensions and widget types name.

**The kernel is small, and everything else is a module.** The kernel is:

- config load, compose, merge and validate (`packages/schema`, `apps/server/src/config`);
- the module host (`apps/server/src/modules`: planning, lifecycle, dependency order);
- the provider registry and poll scheduler;
- the HTTP app skeleton, the CLI and logging;
- the UI manifest resolver (`apps/server/src/ui`);
- the web shell, page registry, data layer and `@/ui` library;
- the SDK itself.

`scripts/kernel-touch.ts` lists these paths (`KERNEL_PATHS`) and reports which of them a diff
touches. A kernel module, `core`, hosts the shell's slots and deck's own widget types.

**Built-ins are modules too.** There are 19 of them, listed statically in
`apps/server/src/modules/builtin.ts`:

- the features: `portal`, `inventory`, `drift`, `monitoring`, `sources`, `actions`,
  `llm-usage` and `metrics`;
- **one data-source module per provider kind**: `link`, `http-health`, `http-json`, `remote`,
  `docker`, `gatus`, `prometheus`, `alertmanager`, `markdown-tree`, `file-tree` and
  `snapshot`.

Data-source modules contribute provider kinds, and feature modules consume providers by kind or
instance id, so a new data source reaches existing generic widgets with no feature change. Where
a built-in needs something the contract lacks, the contract grows; there is no private back door.

**Module config lives under `modules.<id>`.** `schemaVersion: 2` is a hard cut: v1 `groups`,
`actions` and `llmUsage` moved to `modules.portal.groups`, `modules.actions.actions` and
`modules.llm-usage`. Boot refuses a v1 document with `CONFIG_MIGRATION_REQUIRED`, and
`deck config migrate` rewrites one layer by layer. The estate contract stays kernel schema: data-source
*instances* (`integrations[]`, `sources[]`) stay top-level, because many places refer to them by id.

**The schema is composed at boot.** `composeConfig` (`packages/schema/src/compose`) takes the
kernel schema (`deck.schema.json`, kernel keys only) and the enabled modules' contributions. It
builds `modules.properties` from their section schemas, and adds per-kind instance schemas for
`integrations[]` and `sources[]`. It also registers their ownership, identity, references and
finding codes. The root and `modules` stay closed, so an unknown key or module is still
rejected (`MODULE_UNKNOWN`). `deck validate` composes the same way, so offline validation
matches boot.

**Co-location.** Once the contract was stable, the built-ins started moving from feature
directories in each app into one workspace package each, `modules/<id>/`:

- `schema.json`;
- `server/` (its `module.ts` is what the built-in list imports);
- `web/` (discovered by the web registry);
- `test/server/` and `test/web/`.

Built-ins have no `module.json`. Their manifest is TypeScript, and the UI part of it is shared
with the web as data from `@deck/contract/modules/<id>`. Only a runtime module ships its
manifest as JSON (`deck-module.json`).

## Consequences

- **A new module barely touches the kernel.** A built-in adds one line to the static list in
  `builtin.ts`, and a runtime module or a sidecar touches nothing, unless it needs a new kernel
  capability. `kernel-touch.ts` measures this, and `apps/server/test/kernel-names.test.ts` fails if boot,
  the app skeleton or the provider registry names any built-in module or provider kind.
- **A broken module is contained.** A malformed manifest (`MODULE_MANIFEST_INVALID`), an
  incompatible `deckApi` (`MODULE_API_INCOMPATIBLE`), a missing dependency
  (`MODULE_DEPENDENCY_MISSING`) or a failing kind handler (`MODULE_KIND_HANDLER_FAILED`)
  disables that module with a finding, and boot continues. Two exceptions fail fast:
  - a module whose own config section is invalid, as before;
  - an `init` that throws, because its side effects cannot be undone.
- **Config is checked against what is installed.** A section for an unknown module is
  rejected. A section for a module that is installed but switched off is the advisory
  `MODULE_SECTION_DISABLED`, not silently ignored.
- **Ownership is explicit.** Env var names, finding codes, provider kinds, routes and root paths
  each belong to one module, and the host refuses a module that claims another's. Secrets
  reach only the module that declares them.
- **The first releases on the contract were mostly invisible.** Moving every built-in onto it
  added no user feature. Parity goldens (`apps/server/test/golden/parity`) held the providers,
  health, routes, findings and rendered config of a migrated v1 estate unchanged throughout.
- **v0.4.0 is breaking.** Every estate needs `deck config migrate` once.
- **Module config still needs a restart.** Only the `ui` section reloads live (ADR-006):
  re-initialising a module in place is out of scope.
- **The contract is pre-1.0.** `DECK_API_VERSION` is `0.1.0`, so a minor bump may break modules.
  `ctx.http` exposes Hono's own type, which is provisional until `deckApi` 1.0.

## Related

- [Kernel and modules](../../explanation/kernel-and-modules.md)
- [Module manifest reference](../../reference/module-manifest.md)
- [Write a module](../../guides/write-a-module.md)
- [ADR-006: Config-driven UI as one extension tree](./adr-006-config-driven-ui.md)
- [ADR-007: Graded extension tiers with a trust model per tier](./adr-007-extension-tiers-and-trust.md)
