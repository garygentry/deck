# @deck/module-llm-usage

deck's built-in `llm-usage` module: it collects Claude and Codex usage (statusLine ingest, OAuth,
transcripts, the Codex app-server and rollouts) on an adaptive cadence, serves `/api/llm-usage`,
and contributes the LLM usage page, its header pill and its portal card. The operator guide is
`docs/guides/llm-usage.md`.

| Path | Holds |
|---|---|
| `schema.json` | the `modules.llm-usage` config section schema (`server/config.generated.ts` is generated from it: `pnpm --filter @deck/server gen:module-types`) |
| `server/` | the server half; `server/module.ts` is what `apps/server/src/modules/builtin.ts` lists |
| `web/` | the web half; `web/index.ts` registers it, discovered by `apps/web/src/registry/discover.ts` |
| `test/server/`, `test/web/` | unit tests, run by `@deck/server` and `@deck/web`'s test suites |

There is no `module.json`: a built-in's manifest is TypeScript. Its data half (pages, pill, card)
is `@deck/contract/modules/llm-usage`, which the web loads too, and `server/module.ts` spreads it
into the server manifest. There is no build or test script here: each half compiles and is tested
inside its host app. React, react-dom, react-query and vitest are peer dependencies (with dev
dependencies for the tests): the app and its modules share one instance of each. Tests that drive
the module through the kernel (the module host, the app, the config pipeline) stay in
`apps/server/test`.
