# @deck/module-docker

deck's built-in `docker` module: the first `integrations[]` instance of kind `docker`
`{ baseUrl, credentialEnv? }` becomes the provider `docker`, which lists containers from a Docker
Engine API endpoint (typically a socket proxy) with their run state and health. A host or service
binding of this kind registers nothing; it selects entries from that provider's data, which the
portal reads for card status. The binding's status vocabulary is
`@deck/contract/modules/data-sources`.

| Path | Holds |
|---|---|
| `server/` | the server half; `server/module.ts` is what `apps/server/src/modules/builtin.ts` lists, `server/index.ts` is the provider and `server/instance.schema.json` is the integration instance schema |

The module is server-only: it has no config section (so no `schema.json`) and no web half. There
is no `module.json`: a built-in's manifest is TypeScript. There is no build or test script here:
the server half compiles and is tested inside `apps/server`. Its tests drive the provider through
the kernel's registry and scheduler, so they stay in `apps/server/test` (`docker.test.ts`, with
the registration helper in `test/util/register-kinds.ts`).
