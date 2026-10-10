# @deck/module-http-json

deck's built-in `http-json` module: each `integrations[]` instance of kind `http-json`
`{ id, title, url, method?, headers?, body?, credentialEnv?, auth?, ... }` becomes a provider under the
instance's own id, which polls the URL and serves the parsed JSON body as the envelope's `data`.
The only credential is the one the instance's `credentialEnv` names, read at poll time: config
that holds what looks like a credential (a header, query parameter or body key) is refused
(`HTTP_JSON_LITERAL_CREDENTIAL`). The kind is not bindable.

| Path | Holds |
|---|---|
| `server/` | the server half; `server/module.ts` is what `apps/server/src/modules/builtin.ts` lists, `server/index.ts` is the provider, `server/fetch.ts` the hardened request, `server/literal.ts` the URL and literal-credential checks, `server/request-config.ts` the instance's request settings and `server/instance.schema.json` the integration instance schema |

The module is server-only: it has no config section (so no `schema.json`) and no web half. There
is no `module.json`: a built-in's manifest is TypeScript. There is no build or test script here:
the server half compiles and is tested inside `apps/server`. Its tests drive the provider through
the kernel's registry, scheduler and app, so they stay in `apps/server/test` (`http-json.test.ts`).
The `remote` module (`modules/remote`) reuses this module's request, URL and credential handling.
