# @deck/module-drift

deck's built-in `drift` module: inventory beside reality. It contributes the `/drift` page (drift
findings and coverage), its topbar summary pill and the findings sections on the host and service
detail pages. It has no config section and no server code of its own: the web half derives its
projection in the browser from the snapshot provider, with the `@deck/drift` library
(`packages/drift`, which stays a package of its own). It reads the snapshot through the inventory
module's web half, its store and model, imported only from inventory's public web entry
(`modules/inventory/web/public.ts`); the dependency is declared in `server/module.ts` (`dependsOn`)
and in `package.json`.

| Path | Holds |
|---|---|
| `server/` | the server half; `server/module.ts` is what `apps/server/src/modules/builtin.ts` lists |
| `web/` | the web half; `web/index.ts` registers it, discovered by `apps/web/src/registry/discover.ts` |
| `test/server/`, `test/web/` | unit tests, run by `@deck/server` and `@deck/web`'s test suites |

There is no `schema.json` (drift has no `modules.drift` section) and no `module.json`: a built-in's
manifest is TypeScript. Its data half (page, nav entry, pill, sections) is
`@deck/contract/modules/drift`, which the web loads too, and `server/module.ts` spreads it into the
server manifest, adding `dependsOn: ["snapshot", "inventory"]`. There is no build or test script here: each half
compiles and is tested inside its host app. React and vitest are peer dependencies (with dev
dependencies for the tests): the app and its modules share one instance of each. Tests that drive
the module through the kernel (the registry, the app shell, the health header) stay in
`apps/web/test`, as do the ones that also reach the inventory or monitoring module.
