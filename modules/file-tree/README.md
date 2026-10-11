# @deck/module-file-tree

deck's built-in `file-tree` module: each `sources[]` instance of kind `file-tree` (a config tree,
from a local path or a git repository) becomes a provider with the source's id, serving the
source's tree manifest. The Configs page renders it. The module offers the `sources/reader`
service the `sources` module reads its stores through.

| Path | Holds |
|---|---|
| `server/` | the server half; `server/module.ts` is what `apps/server/src/modules/builtin.ts` lists, `server/index.ts` is the provider and `server/instance.schema.json` is the source instance schema |

The module is server-only: it has no config section (so no `schema.json`) and no web half. There
is no `module.json`: a built-in's manifest is TypeScript. The provider is a thin adapter over a
source store; the store, acquisition and the manifest it serves are shared with `markdown-tree` and
live in `modules/sources/server` (`kind-module.ts` builds this module). There is no build or
test script here: the server half compiles and is tested inside `apps/server`. Its tests drive
the provider through the kernel's module host and registry, so they stay in `apps/server/test`
(`sources-providers`, `sources-module`, `sources-runtime` and `module-services`).
