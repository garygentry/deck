# @deck/module-portal

deck's built-in `portal` module: the launch portal. It owns the overlay-owned `modules.portal`
section (groups of service and link cards, with subgroups) and contributes the `/portal` page, its
`portal/groups` widget (search plus the status and group filters) and the topbar endpoint pill. It
has no server code of its own: the web half renders from `/api/config` and the providers.

| Path | Holds |
|---|---|
| `schema.json` | the `modules.portal` config section schema (`server/config.generated.ts` is generated from it: `pnpm --filter @deck/server gen:module-types`) |
| `contract.ts` | the data half of its manifest (page, nav entry, slot, pill, widget type), which `server/module.ts` spreads in and `web/index.ts` registers against; data only, so the web bundle loads it too |
| `status-kinds.ts` | `BUILTIN_STATUS_KINDS`: the built-in status kinds, built from the docker, gatus and http-health `contract.ts` entries (declared dependencies), which the web half uses for card status precedence and as its fallback when the UI manifest cannot be read |
| `server/` | the server half; `server/module.ts` is what `apps/server/src/modules/builtin.ts` lists |
| `web/` | the web half; `web/index.ts` registers it, discovered by `apps/web/src/registry/discover.ts` |
| `test/web/` | unit tests, run by `@deck/web`'s test suite |

There is no `module.json`: a built-in's manifest is TypeScript. Its data half (page, nav entry,
slot, pill, widget type) is `contract.ts`, which the web loads too, and
`server/module.ts` spreads it into the server manifest. There is no build or test script here:
each half compiles and is tested inside its host app. React and vitest are peer dependencies (with
dev dependencies for the tests): the app and its modules share one instance of each. Tests that
drive the module through the kernel (the module host, the config pipeline, the app shell) stay in
`apps/server/test` and `apps/web/test`.
