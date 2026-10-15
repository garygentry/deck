# @deck/module-inventory

deck's built-in `inventory` module: declared hosts and services beside the snapshot's observed
reality. It contributes the `/hosts` and `/services` pages and their detail pages, which render the
shell's entity-sections host (`apps/web/src/shell/EntitySections.tsx`), where other modules attach
their sections (drift findings, for one). The estate's `hosts` and
`services` stay kernel config, since every module references them; this module only renders
them, so it has no config section and no server code of its own. Its snapshot store
and model are what the drift module reads, through the public web entry `web/public.ts`: the only
file another module may import.

| Path | Holds |
|---|---|
| `server/` | the server half; `server/module.ts` is what `apps/server/src/modules/builtin.ts` lists |
| `web/` | the web half; `web/index.ts` registers it, discovered by `apps/web/src/registry/discover.ts` |
| `test/server/`, `test/web/` | unit tests, run by `@deck/server` and `@deck/web`'s test suites |

There is no `schema.json` (inventory has no `modules.inventory` section) and no `module.json`: a
built-in's manifest is TypeScript. Its data half (pages, nav entries) is
`@deck/contract/modules/inventory`, which the web loads too, and `server/module.ts` spreads it into
the server manifest, adding `dependsOn: ["snapshot"]`. There is no build or test script here:
each half compiles and is tested inside its host app. React, react-dom and vitest are peer
dependencies, and react-query a shared one, each with a dev dependency for the tests: the app and
its modules share one instance of each. Tests that drive the module through the kernel (the
registry, the app shell, its entity sections) stay in `apps/web/test`, as does the shared
`inventory-harness.ts` that the drift and monitoring tests use too.
