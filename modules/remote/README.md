# @deck/module-remote

deck's built-in `remote` module: each `integrations[]` instance of kind `remote` points at an
out-of-process sidecar that speaks the remote provider protocol. deck polls the sidecar's data
endpoint as the provider under the instance's own id, asks its describe endpoint which widgets and
links to show, and renders them on the instance's page (`page:remote/<id>`, by default at
`/remote/<id>`), with an optional sidebar entry. A describe answer is checked all or nothing
against the widget allowlist and bounds; a failure is a `REMOTE_*` finding, never a boot failure.
The kind is not bindable.

| Path | Holds |
|---|---|
| `server/` | the server half; `server/module.ts` is what `apps/server/src/modules/builtin.ts` lists, `server/provider.ts` is the provider, `server/describe.ts` checks a describe answer, `server/directory.ts` holds each instance's page settings, last good describe and latest problem and `server/pages.ts` turns them into pages |

The module is server-only: it has no config section (so no `schema.json`) and no web half (its
pages render through the kernel's config pages). There is no `module.json`: a built-in's manifest
is TypeScript. There is no build or test script here: the server half compiles and is tested
inside `apps/server`. Requests, URL checks and credential handling are the `http-json` module's
(`modules/http-json/server`), imported by path. `markdown-it` renders sidecar markdown here
only, but `apps/server` still declares it: the host's declaration is what the module-deps guard
compares this module's copy against, so the server and its modules keep one instance. Its tests stay in `apps/server/test`:
`remote.test.ts` and `remote-sidecar-example.test.ts` drive the module through the kernel (the
registry, scheduler, app, config pipeline and UI manifest), and `remote-describe-throws.test.ts`
mocks a module file with `vi.mock`, whose path is not a module specifier a pure move may rewrite.
