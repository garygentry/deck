# @deck/sdk

What a runtime module's web half builds against. At runtime, deck's page serves `@deck/sdk`
itself, through its import map (built from `apps/web/src/sdk`). This package holds what an
author needs at build time:

| Export | What it is |
| --- | --- |
| `@deck/sdk` (types only) | `index.d.ts`: the types of what deck serves under that name. It is generated from deck's own SDK entry by `pnpm --filter @deck/sdk types:build`, and `test/types-lockstep.test.ts` fails when the file is out of date. |
| `@deck/sdk/tailwind` | The Tailwind v4 preset for a module's own styles: `@import "@deck/sdk/tailwind" prefix(<prefix>);`, where the prefix is the module id's letters, lowercased. It provides utilities only, over deck's tokens. |
| `@deck/sdk/tailwind/theme.css` | The token utilities (`@theme inline`) and the `dark` variant. deck's own stylesheet imports this same file, so a module's `bg-card` is deck's. |
| `@deck/sdk/lint` | deck's UI guardrail rules. `apps/web/test/ui-guardrails.test.ts` runs them on deck's web app, and `deck-module lint` runs them on a module. |
| `deck-module` (bin) | `deck-module lint [dir]` checks a module directory. |

Start a module from [`examples/modules/hello`](../../examples/modules/hello). See
[Start from the template](../../docs/guides/runtime-modules.md#start-from-the-template) for the
build, the styles and the lint rules.

`lint/` runs as it is under Node's type stripping, so it uses erasable TypeScript only.
