# Write a module

A module adds a capability to deck: a page, a header pill, a card, a section on the host pages, a
provider, HTTP routes, a config section, or a new kind of data source. This guide writes one in
this repository, as a built-in compiled into deck and shipped with it. Every built-in feature
is a module on the same contract, so the built-ins are the best examples to read beside it.

Choose the right tier first ([Kernel and modules](../explanation/kernel-and-modules.md#choosing-how-to-extend-deck)):

- If config can do it, use config: [Customise the UI](customise-the-ui.md) and
  [Build a dashboard without code](build-a-dashboard.md).
- For data that needs code but not deck's process, write a [sidecar](write-a-sidecar-module.md).
- For a module only your own deck runs, write a [runtime module](runtime-modules.md). It uses
  the same manifest and server contract, but is built and loaded outside deck.

This guide uses a module called `backups`, which lists backup jobs from its config section and
shows them on a page, with a header pill.

## Lay out the package

A built-in module is one workspace package, `modules/<id>/`:

```text
modules/backups/
  package.json       # @deck/module-backups: its own dependencies, no build or test script
  README.md          # what it does, and where its operator docs are
  schema.json        # the modules.backups section's JSON Schema
  server/
    module.ts        # the server half: defineServerModule(manifest, init, …)
    config.generated.ts
  web/
    index.ts         # the web half: registerWebModule(defineWebModule(…))
    BackupsPage.tsx
    BackupsPill.tsx
  test/
    server/          # run by @deck/server's test suite
    web/             # run by @deck/web's test suite
```

The UI part of its manifest is data in `packages/contract/src/modules/backups.ts`, so the
browser bundle can read it without loading server code. A built-in has no `module.json`: its
manifest is TypeScript.

Each half compiles and is tested inside its host app (`apps/server`, `apps/web`), so the
package has no build, typecheck or test script of its own. Copy `package.json` from an existing
co-located module, such as `modules/llm-usage`, and change its name, description and
dependencies. Then run `pnpm install` at the repository root to link it.

Some built-ins have not moved yet: they still live in `apps/server/src/<id>/` (or
`providers/<kind>/`) and `apps/web/src/features/<feature>/`. They follow the same contract.

## Declare what it adds to the UI

Write the identity and UI contributions as a `WebModuleManifest` in
`packages/contract/src/modules/backups.ts`. The contract package exports every file there as
`@deck/contract/modules/<name>`, so both halves can import it:

```ts
import type { WebModuleManifest } from "@deck/module-sdk";

/** The backups module's identity and UI contributions, shared by its server and web halves. */
export const BACKUPS_UI: WebModuleManifest = {
  id: "backups",
  version: "1.0.0",
  deckApi: "^0.1",
  contributes: {
    pages: [{ id: "page:backups/overview", path: "/backups", title: "Backups", icon: "archive", component: "BackupsPage" }],
    nav: [{ id: "nav:backups/overview", page: "page:backups/overview", group: "operate" }],
    extensions: [
      { id: "pill:backups/summary", kind: "pill", attachTo: { slot: "app/topbar.status", order: 60 }, component: "BackupsPill" },
    ],
  },
};
```

- Every id is `<kind>:backups/<name>`. Config overrides and `GET /api/ui` use these ids, so treat
  them as public: renaming one breaks every operator's override of it.
- A page path must not collide with another page. Built-in nav groups are `overview`,
  `inventory`, `health`, `operate` and `knowledge`.
- Icons come from the web's icon set (`apps/web/src/ui/lib/icons.ts`). Add a Lucide icon there
  by name if you need a new one. That file is part of the kernel, so a new icon is an expected
  second kernel touch.

Every key is in the [module manifest reference](../reference/module-manifest.md).

## Write the server half

`server/module.ts` spreads the shared part in, adds what only the server needs (the config
section, env vars, routes), and gives the `init` that runs once at boot:

```ts
import { BACKUPS_UI } from "@deck/contract/modules/backups";
import { defineServerModule, type JsonSchema, type ModuleManifest } from "@deck/module-sdk";

import type { Backups } from "./config.generated.js";
import schema from "../schema.json" with { type: "json" };

export const BACKUPS_MANIFEST: ModuleManifest = {
  ...BACKUPS_UI,
  enabledBy: { config: true },          // runs only when modules.backups is present
  config: { schema: schema as JsonSchema, ownership: { "": "overlay" } },
};

export const backupsModule = defineServerModule<Backups>(BACKUPS_MANIFEST, (ctx) => {
  const jobs = ctx.config?.jobs ?? [];
  // A provider the kernel polls and serves at /api/providers/backups.
  ctx.providers.register(
    { id: "backups", kind: "backups", health: async () => ({ ok: true }), fetch: async () => ({ jobs }) },
    { pollIntervalMs: 60_000 },
  );
  // A route of its own: GET /api/m/backups/jobs.
  ctx.http.get("/jobs", (c) => c.json({ jobs }));
  ctx.health.report(() => ({ state: "ok", detail: `${jobs.length} job(s)` }));
});
```

Everything the module may use arrives in `ctx`:

- its section (`ctx.config`) and a scoped logger;
- the env vars its manifest lists (`ctx.env`);
- provider registration and a scheduler with an adaptive cadence;
- an HTTP sub-app at `/api/m/<id>`;
- a data directory, `ctx.dataDir()`;
- health reporting and stop hooks.

The [`@deck/module-sdk` README](../../packages/module-sdk/README.md#server-module-context)
describes each one. Register providers, tasks and routes in `init`, not later. A module that
needs a credential lists the variable in `env`, which that module then owns: no other module may
declare it, and `ctx.env` hands it to no other module. A name read from config through
`envFromConfig` is not exclusive: another module may be allowed the same name. Either way,
`ctx.env` only filters what deck hands a module. It is not isolation, because in-process code can
read `process.env` directly.

Then add the module to the static list in `apps/server/src/modules/builtin.ts`: one import and
one array entry. That list is a kernel file, and, with a new icon if you need one, it is the
only one a new built-in should touch.

## Give it a config section

`schema.json` is the `modules.backups` section's schema:

```json
{
  "title": "Backups",
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "jobs": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["name", "schedule"],
        "properties": { "name": { "type": "string", "minLength": 1 }, "schedule": { "type": "string", "minLength": 1 } }
      }
    }
  }
}
```

- Generate its TypeScript type: add the schema and its output path to `MODULE_SCHEMAS` in
  `apps/server/src/scripts/gen-module-types.ts`, then run
  `pnpm --filter @deck/server gen:module-types`. A test fails when a generated file is out of
  date.
- `ownership` says which layer may set each key: the overlay by default. Generated inventory
  belongs to the base layer, and hand-written presentation and intent belong to the overlay.
- If layers should merge a list by id rather than replace it, declare `identity`
  (`{ "jobs[]": ["name"] }`). To refuse duplicate ids, declare `unique`.
- For a check the schema cannot express, add a pure `configRules` function to
  `defineServerModule`'s options, and declare each finding code it reports in
  `config.findings`.

deck composes the section into the config schema at boot, and `deck validate` does the same, so
an invalid section is caught before deploy.

## Add the web half

`web/index.ts` pairs the shared manifest with a table of components and registers it. The web
app discovers every `modules/*/web/index.ts`:

```ts
import { BACKUPS_UI } from "@deck/contract/modules/backups";
import { defineWebModule } from "@deck/module-sdk";

import { registerWebModule } from "@/registry/web-module.js";
import { BackupsPage } from "./BackupsPage.js";
import { BackupsPill } from "./BackupsPill.js";

registerWebModule(defineWebModule(BACKUPS_UI, { components: { BackupsPage, BackupsPill } }));
```

- Build the components from `@/ui` (`PageHeader`, `DataTable`, `StatusBadge`, `EmptyState`, …)
  and follow [the web UI conventions](../architecture/ui.md): tones rather than colours, `<Icon>`
  names, a `data-slot` on the page root and one `h1` per page. `apps/web/test/ui-guardrails.test.ts`
  checks a module's web half too.
- Read data through the shared hooks in `@/data`: `useProvider("backups")` for the provider, and
  `useConfig()` for the estate config. Never `fetch` config or provider data yourself.
- The web half adds no paths, slots or orders: `registerWebModule` takes them all from the
  manifest, and refuses a component the manifest does not name or a name the table lacks.
- A pill takes `HealthSummary`. Check the table with `satisfies` against each slot's component
  contract.

## Add a data source (optional)

A data-source module owns a provider kind, so estates can declare instances of it in
`integrations[]` or `sources[]`, or bind it to hosts and services. Declare the kind in
`providerKinds` (with its `instanceSchema`, and `bindable`, `statusCapable` and `status` if a
binding should give portal cards a status). Then handle it in the server half's `kinds`:

```ts
defineServerModule(manifest, init, {
  kinds: {
    backups: {
      instances: (instances, { envFor }) =>
        instances.map((instance) => ({ provider: new BackupServerProvider(String(instance.id), instance, envFor(instance)) })),
    },
  },
});
```

The kernel calls the handlers before any `init`, and registers what they offer. `envFor`
unlocks only the credential variable that one instance names. See
[Provider kinds](../../packages/module-sdk/README.md#provider-kinds) in the SDK README and the
`apps/server/src/providers/*` modules.

## Test it

- **Unit tests** go in `test/server/` and `test/web/`. Run them with the host app's suite:
  `pnpm --filter @deck/server test` and `pnpm --filter @deck/web test:unit`.
- **Server test fixtures that list every built-in:**
  - add the manifest to `BUILTIN_MANIFESTS` in `apps/server/test/util/modules.ts`, so test hosts
    treat it as built-in;
  - add its id to the built-in id list and the expected plan orders in
    `apps/server/test/module-host.test.ts`.
- **Through the kernel:** tests that boot the module host, the app or the config pipeline stay
  in `apps/server/test`.
- **A web half's contract:** test it with React Testing Library role queries, as for any page.
- **The UI manifest goldens** (`apps/server/test/golden/ui/`) list every built-in's
  contributions, so a new module changes them. Refresh them with
  `DECK_UPDATE_GOLDENS=1 pnpm --filter @deck/server exec vitest run test/ui-golden.test.ts`, and
  review the diff: it should add your ids and nothing else.
- **Kernel touch:** run `bun scripts/kernel-touch.ts` (with `--base <ref>` when your branch
  is not based on `main`). It lists the kernel files your branch touches, which should be
  `apps/server/src/modules/builtin.ts` alone, plus `apps/web/src/ui/lib/icons.ts` if you added
  an icon. Anything more means the
  contract lacks something; say so in review rather than reaching around it.

## Check it runs

Copy the example estate into a scratch directory, so the committed example stays as it is, and
add a layer with the module's section:

```bash
estate=$(mktemp -d) && cp -r examples/estate/. "$estate"
cat > "$estate/20-backups.yaml" <<'YAML'
schemaVersion: 2
modules:
  backups:
    jobs:
      - { name: nas-nightly, schedule: "02:00" }
YAML
DECK_CONFIG_DIR="$estate" pnpm dev
```

```bash
curl -s localhost:8788/api/ui | jq '.modules[] | select(.id == "backups")'
curl -s localhost:8788/api/providers/backups | jq .data
```

Open `/backups` in the web app. Check the page and the pill at phone and desktop widths, in light
and dark mode, and with the keyboard.

Then remove `20-backups.yaml`. That change is outside `ui`, so deck reports
`UI_RESTART_REQUIRED` and keeps the module running until it restarts. After a restart,
`GET /api/ui` lists the module as off, with `enabledBy` naming `modules.backups`, and `/backups`
says the module is not enabled.

## See also

- [Module manifest reference](../reference/module-manifest.md)
- [`@deck/module-sdk` README](../../packages/module-sdk/README.md): the server context,
  services, cadence and lifecycle.
- [Web UI architecture: a module's web half](../architecture/ui.md#a-modules-web-half)
- [Run a runtime module](runtime-modules.md)
- [ADR-005: One module contract for every feature](../architecture/decisions/adr-005-module-contract-and-kernel.md)
