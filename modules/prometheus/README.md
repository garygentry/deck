# @deck/module-prometheus

deck's built-in `prometheus` module: the first `integrations[]` instance of kind `prometheus`
`{ baseUrl, credentialEnv?, card? }` becomes the provider `prometheus`, which runs the summary
queries the instance's `card.summaries` declares against the Prometheus HTTP API and reports each
value with a threshold-derived status. An invalid summary entry is dropped with a warning on the
module's logger, never failing boot. The kind is not bindable: a host or service binding of it is
reported (`PROVIDER_BINDING_UNSUPPORTED`) and ignored. The monitoring module's web half polls
`/api/providers/prometheus` for these summaries.

| Path | Holds |
|---|---|
| `server/` | the server half; `server/module.ts` is what `apps/server/src/modules/builtin.ts` lists, `server/index.ts` is the provider, `server/parse-card.ts` parses `card.summaries` and `server/instance.schema.json` is the integration instance schema |

The module is server-only: it has no config section (so no `schema.json`) and no web half. There
is no `module.json`: a built-in's manifest is TypeScript. There is no build or test script here:
the server half compiles and is tested inside `apps/server`. Its tests drive the provider through
the kernel's registry and scheduler, so they stay in `apps/server/test` (`prometheus.test.ts` and
`metrics-provider-config.test.ts`, with the registration helper in `test/util/register-kinds.ts`).
