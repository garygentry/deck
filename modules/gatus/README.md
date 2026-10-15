# @deck/module-gatus

deck's built-in `gatus` module: the first `integrations[]` instance of kind `gatus`
`{ baseUrl, credentialEnv? }` becomes the provider `gatus`, which reads endpoint statuses from a
Gatus instance and reports whether each endpoint is up and its latest latency. A host or service
binding of this kind registers nothing; it selects entries from that provider's data, which the
portal reads for card status. The binding's status vocabulary is
`contract.ts`.

| Path | Holds |
|---|---|
| `contract.ts` | `GATUS_STATUS_KIND`, the binding's status vocabulary as the UI manifest lists it (kind, module, fixed provider id, status): `server/module.ts` builds its `providerKinds` entry from it, and the portal's `modules/portal/status-kinds.ts` reads it through this public entry. Data only, so the web bundle loads it |
| `server/` | the server half; `server/module.ts` is what `apps/server/src/modules/builtin.ts` lists, `server/index.ts` is the provider and `server/instance.schema.json` is the integration instance schema |

The module is server-only: it has no config section (so no `schema.json`) and no web half (its
`contract.ts` is data). There
is no `module.json`: a built-in's manifest is TypeScript. There is no build or test script here:
the server half compiles and is tested inside `apps/server`. Its tests drive the provider through
the kernel's registry and scheduler, so they stay in `apps/server/test` (`gatus.test.ts`, with
the registration helper in `test/util/register-kinds.ts`).
