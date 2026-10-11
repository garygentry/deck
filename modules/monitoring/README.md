# @deck/module-monitoring

deck's built-in `monitoring` module: the monitoring page (alerts, metrics and integration cards)
and the alerts and metrics header pills. It renders what the alerting and metrics data sources
provide, so it has no config section (no `schema.json`) and its server half only registers the
manifest.

| Path | Holds |
|---|---|
| `server/` | the server half; `server/module.ts` is what `apps/server/src/modules/builtin.ts` lists |
| `web/` | the web half; `web/index.ts` registers it, discovered by `apps/web/src/registry/discover.ts` |
| `test/web/` | unit tests, run by `@deck/web`'s test suite |

There is no `module.json`: a built-in's manifest is TypeScript. Its data half (page and pills) is
`@deck/contract/modules/monitoring`, which the web loads too, and `server/module.ts` spreads it
into the server manifest. There is no build or test script here: each half compiles and is tested
inside its host app. React and vitest are peer dependencies (with dev dependencies for the tests):
the app and its modules share one instance of each. Tests that drive the module through the
kernel stay in the apps: `apps/server/test/monitoring-module.test.ts` (with metrics) and
`apps/web/test/alerts-registration.test.ts` (the registry and header slot). So do
`alerts-summary` and `monitoring-page`, whose `vi.mock` paths are not module specifiers to the
pure-move check.
