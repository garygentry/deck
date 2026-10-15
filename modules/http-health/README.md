# @deck/module-http-health

deck's built-in `http-health` module: a host or service binding `{ url, method?, timing? }`
becomes an `http-health` provider that requests the URL on every poll and reports whether it is
up, its HTTP status and its latency. It does not follow redirects (a 3xx counts as up), cancels
the response body unread, and is aborted with the poll at its timeout. A `timing` that is not
an object of timing fields, each a whole number of milliseconds in range, is
`HTTP_HEALTH_TIMING_INVALID`, an error that fails validation and boot. The
binding's status vocabulary is `contract.ts`.

| Path | Holds |
|---|---|
| `contract.ts` | `HTTP_HEALTH_STATUS_KIND`, the binding's status vocabulary as the UI manifest lists it (kind, module, status): `server/module.ts` builds its `providerKinds` entry from it, and the portal's `modules/portal/status-kinds.ts` reads it through this public entry. Data only, so the web bundle loads it |
| `server/` | the server half; `server/module.ts` is what `apps/server/src/modules/builtin.ts` lists, and `server/index.ts` is the provider |

The module is server-only: it has no config section (so no `schema.json`) and no web half (its
`contract.ts` is data). There
is no `module.json`: a built-in's manifest is TypeScript. There is no build or test script here:
the server half compiles and is tested inside `apps/server`. Its tests drive the provider through
the kernel's registry and scheduler, so they stay in `apps/server/test` (`providers.test.ts` and
`link-http-health.test.ts`, with the registration helper in `test/util/register-kinds.ts`).
