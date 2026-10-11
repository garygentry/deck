# @deck/module-inventory

deck's built-in `inventory` module: declared hosts and services beside the snapshot's observed
reality. It contributes the `/hosts` and `/services` pages and their detail pages, whose entity
sections host other modules' contributions (drift findings, for one). The estate's `hosts` and
`services` stay kernel config, since every module references them; this module only renders
them, so it has no config section and no server code of its own. Its snapshot store
(`web/inventory-store.ts`) and model (`web/model.ts`) are what the drift module reads.

| Path | Holds |
|---|---|
| `server/` | the server half; `server/module.ts` is what `apps/server/src/modules/builtin.ts` lists |
| `web/` | the web half; `web/index.ts` registers it, discovered by `apps/web/src/registry/discover.ts` |
| `test/web/` | unit tests, run by `@deck/web`'s test suite |

There is no `schema.json` (inventory has no `modules.inventory` section) and no `module.json`: a
built-in's manifest is TypeScript. Its data half (pages, nav entries) is
`@deck/contract/modules/inventory`, which the web loads too, and `server/module.ts` spreads it into
the server manifest, adding `dependsOn: ["snapshot"]`. There is no build or test script here:
each half compiles and is tested inside its host app. React, react-dom and vitest are peer
dependencies (with dev dependencies for the tests): the app and its modules share one instance of
each. Tests that drive the module through the kernel (the module host, the registry, the app
shell) stay in `apps/server/test` and `apps/web/test`, as do the tests that address the module's
files by path string (`vi.mock`, `new URL`) and the shared `inventory-harness.ts` the drift tests
use too.
