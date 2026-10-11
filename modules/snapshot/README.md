# @deck/module-snapshot

deck's built-in `snapshot` module: the observed-reality snapshot named by `DECK_SNAPSHOT_SOURCE`
(a file path or an HTTP(S) URL) becomes the singleton provider `snapshot`, validated against the
estate on every changed read. Unset, no provider is registered. With a provider registered, the
module offers the `snapshot/content` service (when the last good snapshot was generated), which
the `metrics` module reads. The snapshot's wire types are `@deck/contract`'s `snapshot`.

| Path | Holds |
|---|---|
| `server/` | the server half; `server/module.ts` is what `apps/server/src/modules/builtin.ts` lists, `server/index.ts` is the provider, `server/source.ts` reads the file or URL, `server/freshness.ts` derives host freshness and `server/content.ts` is the service reference |
| `test/server/` | unit tests of the source and the freshness rules, run by `@deck/server`'s test suite |

The module is server-only: it is configured by a deployment variable, not the estate document,
so it has no config section (no `schema.json`) and no web half. There is no `module.json`: a
built-in's manifest is TypeScript. There is no build or test script here: the server half
compiles and is tested inside `apps/server`, and it reads the server's provider contract
(`apps/server/src/contract`) and logs read events through its logger
(`apps/server/src/log/logger.ts`). Tests that drive the provider through the kernel (boot, the
registry, the module host, the provider routes and the `snapshot-contract` checks) stay in
`apps/server/test`.
