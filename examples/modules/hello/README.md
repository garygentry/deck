# hello: the runtime module template

Copy this directory to write a runtime module of your own. It is TypeScript and React built
with Vite, and has every part a module can have:

- a page at `/hello`, with a nav entry in the Operate group and an icon of its own;
- a header pill linking to the page;
- a provider, `hello`, that serves the greeting;
- a route, `GET /api/m/hello/greeting`, and health;
- a config section, `modules.hello`, with an optional `greeting`.

```bash
pnpm install                          # at the repository root
pnpm --filter deck-module-hello build # writes dist/hello/
pnpm --filter deck-module-hello lint  # deck-module lint: deck's UI rules
DECK_MODULES_DIR=examples/modules/hello/dist DECK_MODULES_ENABLED=true pnpm dev
```

See [Start from the template](../../../docs/guides/runtime-modules.md#start-from-the-template)
for the layout, the build, the types, styling with deck's tokens and the lint.
