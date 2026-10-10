# @deck/module-alertmanager

deck's built-in `alertmanager` module: the first `integrations[]` instance of kind `alertmanager`
`{ baseUrl, credentialEnv? }` becomes the provider `alertmanager`, which reads active alerts and
silences from the Alertmanager v2 API. The kind is not bindable: a host or service binding of it is
reported (`PROVIDER_BINDING_UNSUPPORTED`) and ignored. The monitoring module's web half polls
`/api/providers/alertmanager` for these alerts.

| Path | Holds |
|---|---|
| `server/` | the server half; `server/module.ts` is what `apps/server/src/modules/builtin.ts` lists, `server/index.ts` is the provider and `server/instance.schema.json` is the integration instance schema |

The module is server-only: it has no config section (so no `schema.json`) and no web half. There
is no `module.json`: a built-in's manifest is TypeScript. There is no build or test script here:
the server half compiles and is tested inside `apps/server`. Its tests drive the provider through
the kernel's registry and scheduler, so they stay in `apps/server/test` (`alertmanager.test.ts` and
`metrics-provider-config.test.ts`, with the registration helper in `test/util/register-kinds.ts`).
