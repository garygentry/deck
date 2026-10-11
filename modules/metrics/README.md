# @deck/module-metrics

deck's built-in `metrics` module: deck's own Prometheus exposition at `GET /metrics`, built from
the provider registry's cached poll statistics with no upstream I/O, plus the snapshot's content
age from the `snapshot` module's `snapshot/content` service. It runs only when
`DECK_METRICS_ENABLED` is `true` or `1`; `/metrics` is a declared root path, so while the module
is off it answers deck's plain 404.

| Path | Holds |
|---|---|
| `server/` | the server half; `server/module.ts` is what `apps/server/src/modules/builtin.ts` lists, and `server/route.ts` renders the exposition |

The module is server-only: it has no config section (so no `schema.json`), no `/api` routes and
no web half. There is no `module.json`: a built-in's manifest is TypeScript. There is no build or
test script here: the server half compiles and is tested inside `apps/server`. Its tests drive
the module through the kernel (the module host, the app's route table and the scheduler), so they
stay in `apps/server/test` (`metrics.test.ts`).
