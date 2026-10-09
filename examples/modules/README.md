# Runtime modules

Each directory here is a runtime module. To load one, copy its module directory into your
`DECK_MODULES_DIR` and set `DECK_MODULES_ENABLED=true`: `maintenance` as it is (it needs no
build), and `hello` once built, from `hello/dist/hello/`. Don't point `DECK_MODULES_DIR` at this
directory itself: `hello/` holds the template's sources, not a module deck can load. See
[Run a runtime module](../../docs/guides/runtime-modules.md).

| Module | What it adds |
| --- | --- |
| [`hello`](hello) | The template to copy: TypeScript and React built with Vite (`pnpm build` writes `dist/hello/`), with a page, a nav entry, a header pill, an icon, a provider, a route and a config section. See [Start from the template](../../docs/guides/runtime-modules.md#start-from-the-template). |
| [`maintenance`](maintenance) | Planned maintenance windows: a web half with a page, a header pill and an icon; a provider, a route and a config section with a rule. |
