# @deck/module-actions

deck's built-in `actions` module: governed actions. It loads the runner allowlist, validates
parameters, executes runs and keeps their audit, serves `/api/actions*`, and contributes the
Actions page. It is off unless `DECK_ACTIONS_ENABLED` is true. The operator guide is
`docs/guides/governed-actions.md`; the design note is `docs/architecture/governed-actions.md`.

| Path | Holds |
|---|---|
| `schema.json` | the `modules.actions` config section schema (`server/config.generated.ts` is generated from it: `pnpm --filter @deck/server gen:module-types`) |
| `server/` | the server half; `server/module.ts` is what `apps/server/src/modules/builtin.ts` lists |
| `web/` | the web half; `web/index.ts` registers it, discovered by `apps/web/src/registry/discover.ts` |
| `test/server/`, `test/web/` | unit tests, run by `@deck/server` and `@deck/web`'s test suites |

There is no `module.json`: a built-in's manifest is TypeScript. Its data half (the Actions page
and its nav entry) is `@deck/contract/modules/actions`, which the web loads too, and
`server/module.ts` spreads it into the server manifest. The parameter validator the server and
the web share is `@deck/contract/actions`. There is no build or test script here: each half
compiles and is tested inside its host app. React, react-dom and vitest are peer dependencies
(with dev dependencies for the tests): the app and its modules share one instance of each. Tests
that drive the module through the kernel (the module host, the app, the config pipeline,
shutdown, registration, the page) stay in `apps/server/test` and `apps/web/test`. So do four
unit tests that could not move as pure renames: `actions-audit`, `-runners` and `-spawn` read
the module's sources by URL, and `actions-ndjson`'s module loading had to change. The fake
runner spawner the server tests share is `test/server/util/fake-spawner.ts`.
