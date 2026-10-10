# @deck/module-sources

deck's built-in `sources` module: it browses the declared `sources[]` (documentation and config
trees), serves `/api/sources` (tree, file, raw and search, every path confined to its source),
and contributes the Docs and Configs pages and the owned-configs section on the host and service
detail pages. It acquires each source (a local path, or a git clone into the
`DECK_SOURCES_CACHE_DIR` cache) through the stores the `markdown-tree` and `file-tree` data
sources (`modules/markdown-tree`, `modules/file-tree`) build, and reads them through the
`sources/reader` service those modules offer. The architecture note is
`docs/architecture/sources-docs-and-configs.md`.

| Path | Holds |
|---|---|
| `server/` | the server half; `server/module.ts` is what `apps/server/src/modules/builtin.ts` lists. It also holds what the two source kinds share: acquisition, confinement, the store, the tree manifest and `kind-module.ts`, which builds a source-kind module. `server/types.ts` is the wire types the web half renders (types only) |
| `web/` | the web half; `web/index.ts` registers it, discovered by `apps/web/src/registry/discover.ts`. `web/markdown.ts` is also the renderer the kernel's markdown widget uses |
| `test/server/`, `test/web/` | unit tests, run by `@deck/server` and `@deck/web`'s test suites; `test/server/util/` holds the fake git spawner and scratch cache dir the server tests share |

There is no `schema.json` (sources has no `modules.sources` section: the sources are the
top-level `sources[]` instances) and no `module.json`: a built-in's manifest is TypeScript. Its
data half (pages, nav entries, sections) is `@deck/contract/modules/sources`, which the web loads
too, and `server/module.ts` spreads it into the server manifest. There is no build or test script
here: each half compiles and is tested inside its host app. React, react-dom and vitest are peer
dependencies (with dev dependencies for the tests): the app and its modules share one instance of
each. Tests that drive the module through the kernel (the module host, the registry, the app, the
config pipeline) stay in `apps/server/test` and `apps/web/test`, as do the tests that address the
module's files by path string (`vi.mock`).
