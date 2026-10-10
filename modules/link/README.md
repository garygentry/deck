# @deck/module-link

deck's built-in `link` module: a host or service binding `{ href, label?, icon? }` becomes a
static `link` provider that serves that descriptor. It is never polled, and it has no status.
`href` must be an http(s) URL or an absolute path in deck: config validation reports any other
as `LINK_HREF_UNSAFE` and a missing one as `LINK_HREF_MISSING` (errors), and such a binding
registers no provider.

| Path | Holds |
|---|---|
| `server/` | the server half; `server/module.ts` is what `apps/server/src/modules/builtin.ts` lists, and `server/index.ts` is the provider |

The module is server-only: it has no config section (so no `schema.json`) and no web half. There
is no `module.json`: a built-in's manifest is TypeScript. There is no build or test script here:
the server half compiles and is tested inside `apps/server`. Its tests drive the provider through
the kernel's registry and scheduler, so they stay in `apps/server/test` (`providers.test.ts` and
`link-http-health.test.ts`, with the registration helper in `test/util/register-kinds.ts`).
