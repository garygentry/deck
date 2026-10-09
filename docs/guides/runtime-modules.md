# Run a runtime module

A runtime module adds a capability to deck without rebuilding it: you drop the module's directory
into `DECK_MODULES_DIR`, switch runtime modules on, and restart deck. The module uses the same
contract as deck's built-in modules. It can add pages, nav entries, header pills, icons,
provider data, HTTP routes under `/api/m/<id>`, health and a config section of its own. Its
server half runs in deck's process; its web half, the components its pages and pills render,
runs in the browser inside deck's own page.

Runtime modules are off by default, and a module you switch on runs with deck's full trust:

- Its server code runs **inside the deck process, with every privilege deck has**: it can read
  deck's environment and files and make any network call deck can.
- Its web half runs **in the browser as deck itself**: it is served from deck's origin, so it
  can call every `/api` route and act with the session of whoever has deck open.

Install only modules you would run as deck itself, and pin each one's contents (see
[Pin the module's contents](#pin-the-modules-contents)) so deck refuses a module that has
changed since you reviewed it. For deck's wider posture, see
[Security & access posture](../security.md).

This guide installs the example module in [`examples/modules/maintenance`](../../examples/modules/maintenance),
which lists planned maintenance windows. It adds:

- a page at `/maintenance`, with a nav entry in the Operate group and an icon of its own;
- a header pill that turns amber while a window is in progress;
- a provider, `maintenance`, that says which window is in progress and which is next;
- a route, `GET /api/m/maintenance/windows`;
- a config section, `modules.maintenance`, with a schema and a config rule.

To write a module of your own, copy the template, as described in
[Start from the template](#start-from-the-template).

## Lay out the modules directory

`DECK_MODULES_DIR` holds one subdirectory per module. Each subdirectory is named by the module's
id:

```text
modules/
  maintenance/
    deck-module.json   # the manifest: required
    server.mjs         # the server entry: optional
    web.js             # the web half: optional
    web.css            # the web half's styles: optional
```

- `deck-module.json` is the module's manifest, the same shape built-in modules declare: `id`,
  `version`, `deckApi`, `enabledBy`, `config`, `contributes`, and so on (see the
  [`@deck/module-sdk` README](../../packages/module-sdk/README.md)). Its `id` must be the
  directory's name.
- The server entry is `server.js`, `server.mjs` or `server.ts`. A module has at most one. Its
  default export is the server module, `{ manifest, init, configRules?, kinds? }`, and its
  `manifest` must equal `deck-module.json`. A module without an entry contributes its manifest
  only.
- The entry imports nothing from deck at runtime: everything it uses comes through the `ctx`
  passed to `init`, so `@deck/module-sdk` is imported for types only. Bundle any other
  dependency into the module directory.
- The web half is `web.js`, with an optional `web.css`; see [Add a web half](#add-a-web-half).
- Directories whose names start with `.` and plain files are ignored.

## Add a web half

The components a module's pages, pills and other extensions name live in `web.js`. It is one
native ES module file, loaded by the browser as it is: bundle anything else it needs into it.
Its default export is the web module, `defineWebModule(manifest, { components })`, the same
shape built-in modules use. Its manifest must be the module's `deck-module.json`: the example
imports it as a JSON module (`import manifest from "./deck-module.json" with { type: "json" }`),
and a built module can inline it.

`web.js` runs in deck's page under deck's Content-Security-Policy. It may `fetch` deck's own
origin only (`connect-src 'self'`): for data from anywhere else, read a provider (your server
half's, or a `remote` or `http-json` integration's) with `useProvider`, or add a route to your
server half. It cannot add `<script>` elements of its own or use `eval`; import everything it
needs. Styles and images are not restricted that way.

```js
import { jsx } from "react/jsx-runtime";
import { defineWebModule, PageHeader, useProvider } from "@deck/sdk";
import manifest from "./deck-module.json" with { type: "json" };

function MaintenancePage() {
  const { envelope } = useProvider("maintenance");
  return jsx(PageHeader, { title: "Maintenance", description: `${envelope?.data?.count ?? 0} windows` });
}

export default defineWebModule(manifest, { components: { MaintenancePage } });
```

`web.js` imports only these bare specifiers, which deck's page maps to its own copies with an
import map, so a module renders with deck's React and reads deck's data:

| Specifier | What it is |
| --- | --- |
| `react`, `react-dom`, `react/jsx-runtime` | The React deck runs. A module must never bundle its own. |
| `@deck/sdk` | deck's module API: `defineWebModule`; the data hooks `useProvider`, `useProviders`, `useConfig` and `useUiManifest`; `Icon`, the tones (`TONES`, `defineStatusMap`, `statusTone`); and deck's display patterns (`PageHeader`, `Section`, `KeyValueList`, `DataTable`, `StatusBadge`, `HealthPill`, `EmptyState`, `ErrorState`, `LoadingState` and the like). |

`@deck/sdk` does not export deck's low-level UI primitives (its buttons, dialogs, menus and
so on): build from the patterns, which carry deck's look and accessibility. For a module's own
layout, `web.css` is linked before `web.js` runs. Use deck's theme tokens for colours
(`var(--muted-foreground)`, for instance), so the module follows the operator's theme preset
and light or dark mode. A module built from the template writes its styles with deck's Tailwind
preset instead; see [Style with deck's tokens](#style-with-decks-tokens).

A module can contribute its own icons as SVG markup in `contributes.icons`, named
`<id>/<name>`; its pages, nav entries, components and `ui.brand.icon` then use that name
wherever an icon goes. A module has at most 64 icons of at most 16 KiB each, and each is an
`<svg xmlns="http://www.w3.org/2000/svg">` document. Icons are plain drawings:

- They may use only shapes and grouping (`path`, `circle`, `ellipse`, `line`, `polyline`,
  `polygon`, `rect`, `g`, `use`, `symbol`, `defs`), gradients, clip paths and masks, and
  `title` and `desc`, with geometry and paint attributes. deck drops other attributes.
- They may not use styles (`<style>` or `style=`), scripts or event handlers, links, images,
  filters or `<foreignObject>`. Every `href` and every `url(…)` must point at an `#id` in the
  icon itself, and no attribute may hold a backslash.
- Paint (`fill`, `stroke`) is `none`, a colour (a keyword such as `currentColor`, hex,
  `rgb()` or `hsl()`) or `url(#id)`; `clip-path` and `mask` are `none` or `url(#id)`;
  `transform` uses the basic functions (`translate`, `rotate` and so on); no other attribute
  may hold a function, so CSS image functions such as `image-set()` are refused.

`deck validate` and boot refuse a manifest whose icons break the plainest of these rules. In
the browser, deck rebuilds each icon from that allowlist and renders the fallback icon in
place of any that breaks one. Ids inside an icon are made unique to each place it renders.

The browser needs JSON module imports for the example's manifest import: Chrome or Edge 123,
Firefox 138 or Safari 17.2 and later. A module that inlines its manifest needs only import
maps, which every current browser supports.

deck serves a module's `web.js`, `web.css` and `deck-module.json` at `/modules/<id>/`, and
nothing else of its directory: not its server entry. It serves them only for a module whose
code it loaded, reading them when it loads the module; with a pin, each must be the file the
pin's digest covered. Anything else under `/modules` is a 404. Restart deck to serve a
changed web half.

The server's manifest decides where a module's contributions go: the shell routes its pages
at the paths, and attaches its extensions to the slots and orders, that `GET /api/ui` lists,
whatever the web half says. The web half supplies the components. A `ui` config reload that
moves a page or switches an extension on or off takes effect at once, without loading the
module again.

The page loads each module's web half once the UI manifest arrives, once per page load. Each
of its components renders inside its own error boundary, so a component that throws shows a
"failed" tile (or, for a page, an error) while the rest of deck keeps working. A web half that
deck cannot use shows a tile and a page that say so, and the browser console says why:

- "incompatible": its manifest's `deckApi` does not accept this deck's module API, its id or
  version differ from the `deck-module.json` the server loaded, or it imports a name that
  `@deck/sdk` or React does not export. Update the module and restart deck.
- "failed to load": `web.js` did not load or did not export a web module; its manifest
  declares other pages, nav entries, slots, extensions or widget types than the server's; it
  lacks a component the server's declarations name; or deck refused what it declares. Reload
  the page to try again.

## Start from the template

[`examples/modules/hello`](../../examples/modules/hello) is the module to copy when you write
your own. It is written in TypeScript and React and built with Vite, and it has every part a
module can have: a page with a nav entry and an icon of its own, a header pill, a provider, a
route, health and a config section. Its build writes a module directory that deck loads as it
is.

```text
hello/
  deck-module.json     # the manifest
  package.json         # build, lint, typecheck and test scripts
  vite.config.ts       # the build: the web half, then the server half
  src/
    server.ts          # the server half
    greeting.ts        # types both halves share
    web/
      index.tsx        # the web half: defineWebModule(manifest, { components })
      HelloPage.tsx
      HelloPill.tsx
      web.css          # the module's own styles
  test/
    template.test.ts   # checks the build and the lint
```

The template builds inside a deck checkout: it is a package of deck's workspace, which provides
`@deck/sdk` (the web half's types, Tailwind preset and `deck-module lint`) and
`@deck/module-sdk` (the server half's types).

1. Copy `examples/modules/hello` to `examples/modules/<id>`, and set `name` in its
   `package.json`.
2. Rename the module from `hello` to your id: the `id` in `deck-module.json`, the module part of
   every contribution id (`page:<id>/main`) and icon name (`<id>/wave`) and the provider id.
   Then set the CSS prefix, in `web.css` and in the classes that use it, to your module's
   prefix: its id lowercased, with every character that is not a letter removed (Tailwind
   prefixes are letters only). For `hello-world` that is `helloworld:`, and for `hello2`,
   `hello:`. `vite.config.ts` names the output directory from the id, and the template's test
   reads both the id and the prefix itself.
3. Run `pnpm install` at the repository root to link the new package.
4. Run `pnpm --filter <name> build`. It writes `dist/<id>/`: `deck-module.json`, `server.mjs`,
   `web.js` and `web.css`.
5. Run `pnpm --filter <name> lint`, `typecheck` and `test`.
6. Copy `dist/<id>` into `DECK_MODULES_DIR` (see
   [Switch runtime modules on](#switch-runtime-modules-on)), or point `DECK_MODULES_DIR` at
   `dist`, and restart deck.

### What the build does

`pnpm build` runs Vite twice into `dist/<id>/`:

- **`vite build`** builds the web half, `src/web/index.tsx`, as one ES module, `web.js`, with
  the stylesheet it imports as `web.css`, and copies `deck-module.json` beside them.
  `react`, `react-dom`, `react/jsx-runtime` and `@deck/sdk` are fixed externals: deck's
  import map provides exactly these, so the build leaves those imports as they are. Never
  bundle them, and don't change the list: a second copy of React breaks every hook. Everything
  else the web half imports, a dynamic `import()` included, is bundled into `web.js`.
- **`vite build --mode server`** bundles the server half, `src/server.ts`, and every
  dependency it has into `server.mjs`. It imports only types from `@deck/module-sdk`, so it
  imports nothing from deck at runtime.

Both halves import `deck-module.json`, and the build inlines it. TypeScript widens a JSON
import's strings, so the template casts it (`as WebModuleManifest`, `as ModuleManifest`);
deck checks at load that each half's manifest is the `deck-module.json` it read.

### Types

In the workspace, `@deck/sdk` resolves to the types of what deck's page serves under that
name. They are generated from deck's own SDK, so `tsc` and your editor check every pattern's
props, the tones and the icon names. The server half takes `ServerModule`, the `ctx` it is
given (`ServerModuleContext`) and the rest from `@deck/module-sdk`, with `import type`.

### Style with deck's tokens

Build from `@deck/sdk`'s patterns first: they need no styles of your own. For the layout they
don't cover, `web.css` imports deck's Tailwind preset, with the module's prefix (its id's
letters, lowercased; see [Start from the template](#start-from-the-template)):

```css
@import "@deck/sdk/tailwind" prefix(hello);
@source "../";
```

Every class then carries the prefix: `hello:flex hello:gap-6 hello:bg-muted hello:rounded-md`.

- **Utilities only.** deck's page already has Tailwind's Preflight and base styles.
- **deck's tokens only.** Colours (`hello:bg-card`, `hello:text-status-warn-fg`), the corner
  radius scale and the fonts are deck's own. They follow the operator's theme preset and light
  or dark mode, and `hello:dark:` follows deck's dark mode. Tailwind's palette
  (`bg-red-500`) and its off-scale radii don't exist. Spacing, type sizes and breakpoints are
  Tailwind's defaults, as in deck.
- **The prefix is required.** A module's stylesheet loads after deck's, into the same cascade
  layer. An unprefixed `p-4` in it would override deck's own `md:p-6` on deck's elements.
- **Style only the module's elements.** Every selector in `web.css` must be scoped to one of
  the module's classes: the element it styles carries one (`.hello\:p-4:hover`), or sits
  inside one (`.hello-card span`). A selector that could match deck's own elements (`h1`,
  `body`, `[data-slot=…]`, `#id`, `:is(.p-4)`) is refused, as are base styles.
- **One prefix per module.** Two runtime modules whose ids have the same letters (`hello` and
  `hello2`, `a-b` and `ab`) would style each other's classes, so deck loads the first by id
  and refuses the other with `collision` (see [When a module fails](#when-a-module-fails)).

### Check it with `deck-module lint`

`deck-module lint [dir]` holds a module to the same UI rules deck's own web app is tested
against. It checks two kinds of file:

- **Sources:** every script (`.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`, `.cjs`) and
  stylesheet in the module, wherever it sits, except dependencies, `dist/` and the module's
  server code: a server entry (`server.*` at the root or in `src/`) and the files only server
  code imports. Tests and tool config (`test/`, `*.test.*`, `*.config.*`) are left out unless
  web code imports them.
- **Build output:** the `web.js` and `web.css` beside a `deck-module.json`, in `dist/<id>/` or
  in the module directory itself. These are what deck serves, so they get the build-output
  rules. When the module has sources elsewhere, or a bundler wrote the file (Tailwind's banner,
  pure annotations or a source map), that is all they get: a bundle carries its dependencies'
  code, which the source rules are not about. In a module with no build step, they are its
  sources too and get both.

The source rules:

| Rule | What it refuses |
| --- | --- |
| `colour-literal` | A hex colour or a colour function (`rgb()`, `hsl()`, `hwb()`, `lab()`, `lch()`, `oklab()`, `oklch()`, `color()`) in scripts or CSS, an arbitrary colour utility (`hello:bg-[red]`, `text-[#f00]`), or a named colour in a CSS value. Use tokens. |
| `radius-scale` | `rounded`, `rounded-2xl`…`4xl` or `rounded-[4px]`, prefixed or not. Use `rounded-xs`…`xl`, `rounded-full` or `rounded-none`. |
| `inline-style` | `style={…}` (or a `style:` prop in plain JavaScript), except in a file allowlisted for dynamic geometry. |
| `data-icon` | A `data-icon` attribute. Use `<Icon name>`. |
| `legacy-token` | deck's removed `--inventory-*`, `--freshness-*` and `--l-*` tokens. |
| `module-import` | A React entry point other than `react`, `react-dom` and `react/jsx-runtime` (it would bundle a second React); a deck package other than `@deck/sdk`, or `@deck/module-sdk` other than `import type`; `radix-ui`, `@radix-ui/*` or `lucide-react` (use the patterns and `<Icon>`); an `import()` of a computed name; `require()` or `import x = require()`. |
| `module-css-import` | `tailwindcss` itself (by name or by a path into it) or an `@tailwind` directive, or `@deck/sdk/tailwind` without the module's prefix. |
| `module-css-selector` | A selector that could match elements other than the module's own (see [Style with deck's tokens](#style-with-decks-tokens)). Rules that only set custom properties of Tailwind's (`--tw-*`) or the module's (`--hello-*`) may select anything; `@keyframes` are not selectors. |

The build-output rules:

| Rule | What it refuses |
| --- | --- |
| `built-web-import` | A `web.js` that imports anything but the four import-mapped specifiers and its own `./deck-module.json` (as a JSON module, `with { type: "json" }`); one that calls `require()`; one that bundles its own React or React DOM. Nothing else resolves in the browser. |
| `built-web-css` | The `module-css-selector` rule, and base styles in Tailwind's Preflight shape (`box-sizing` on `*`, `::before`, `html` or any other selector not scoped to the module); Tailwind's palette variables. |

It prints each offence as `file:line rule: message` and exits 1 when there is one, 0 when there
is none, and 2 when the directory has no `deck-module.json` or its `package.json` cannot be
read. It says so when a module with sources has no built `web.js` to check yet. Run it on a
built module directory as you install it (`deck-module lint dist/<id>`) to check just what deck
will serve. To let a file set an inline style
(a width computed from a value, say), allowlist it in the module's `package.json`:

```json
"deckModule": { "lint": { "styleAllowlist": { "src/web/Gauge.tsx": "fill width from the value" } } }
```

The lint checks what can be read off the source. It does not replace looking at the page in
light and dark mode, at phone width, and with a keyboard.

## Switch runtime modules on

Mount the directory read-only and set both variables:

```yaml
services:
  deck:
    environment:
      DECK_MODULES_DIR: /modules
      DECK_MODULES_ENABLED: "true"
    volumes:
      - ./modules:/modules:ro
```

The example is switched on by its config section (`enabledBy: { config: true }`), so add one to
an overlay layer:

```yaml
modules:
  maintenance:
    windows:
      - name: kernel upgrades
        start: 2026-10-10T02:00:00Z
        durationMinutes: 60
```

`deck validate` checks the section against the module's schema when `DECK_MODULES_DIR` is set.
It reads manifests only and runs no module code, so the module's config rules (here, that
`start` has an offset) run at boot.

## Pin the module's contents

To make deck refuse a module directory that has changed since you reviewed it, pin its digest in
the config:

```bash
bun apps/server/src/cli/deck.ts module digest examples/modules/maintenance
```

```yaml
moduleIntegrity:
  maintenance: sha256-…   # the line the command printed
```

deck computes a module's digest over every file in its directory immediately before it imports
that module, so a module that does not match runs no code. Update the pin whenever you update
the module. If two config layers pin the same module, the later layer's pin is used. See
[Runtime module integrity](../reference/estate-config.md#runtime-module-integrity).

A pin defends against a module directory that has changed since you pinned it, on a mount that
is read-only to deck: it protects the files at rest. It is not a defence against someone who
can write to the directory while deck starts: files a module imports later are read after the
digest is taken.

## When a module's code is loaded

deck reads every `deck-module.json` at boot, whether or not runtime modules are on. That way it
always knows each module's config section and says why a module is off.

While `DECK_MODULES_ENABLED` is off, runtime modules are inert. None of their code runs, a broken
or clashing directory is not an error, and each module is reported off with
`not enabled: DECK_MODULES_ENABLED is not true`.

While it is on, deck works out the whole module plan from the manifests before it imports
anything, exactly as it plans built-in modules: switches, `deckApi`, dependencies, routes and
paths, and env names. It then imports only the modules that plan runs, in dependency order,
each just after checking its pin. If a module fails to load, the plan is worked out again
without it, so a module that depends on it is never imported: it is off with
`MODULE_DEPENDENCY_MISSING`. `deck validate` and `deck render` follow the same order, checking
pins without importing anything. Every other module is off, none
of its code runs, and `GET /api/ui` lists it with the reason and the setting that would switch
it on.

## When a module fails

A runtime module that cannot be loaded is disabled and boot continues. This covers:

- a missing, invalid or oversized `deck-module.json` (over 64 KiB or nested over 32 levels), or
  an `id` that is not its directory's name (`bad manifest`);
- a manifest, entry or pinned directory deck cannot read: no permission, an I/O error, or a
  symbolic link inside a pinned directory (`unreadable`);
- a module directory, manifest or entry that resolves outside `DECK_MODULES_DIR` through a
  symbolic link (`outside DECK_MODULES_DIR`);
- a module that claims what a built-in or another runtime module already has: a finding code,
  a provider kind, a health key, a route or path; or a CSS prefix (its id's letters,
  lowercased) that a runtime module before it by id already has (`collision`);
- a directory that does not match its pin (`pin mismatch`);
- an entry that throws, or that does not export a module whose manifest equals
  `deck-module.json` (`import error`).

deck logs a `module.disabled` warning with the code `MODULE_LOAD_FAILED`, the reason, and a
`detail` field with the full cause. `GET /api/health` reports the module as `disabled`, and both
it and `GET /api/ui` give only the category in parentheses above: never the module's own error
text or a file path. A directory named like a built-in module is left out altogether; the
`modules.runtime` log line lists it under `rejected`.

A module that fails to load claims nothing: no provider kind, finding code, route, path,
health key, nav entry or service. Another module may use them. Only its config section is
kept, so that config you wrote for it is still checked. While runtime modules are off, every
runtime module is out of the plan, so nothing in one can affect a built-in. Other failures follow the rules for every
module: a manifest the host refuses is `MODULE_MANIFEST_INVALID`, and a `deckApi` mismatch is
`MODULE_API_INCOMPATIBLE`.

There is one exception: config you wrote for the module is still checked. If the module's
section is present and invalid against the schema in its `deck-module.json`, boot fails as it
would if the module had loaded. When the manifest itself cannot be read, its schema is unknown,
so the section is not checked.

Two failures stop boot with exit class 2, because deck cannot stop the code involved:

- an entry that does not finish importing within 10 seconds, since its code may still be
  running;
- once loaded, an `init` that throws: a runtime module runs under the same lifecycle as a
  built-in, and its stop hooks run at shutdown.

## Check that it runs

At boot, deck logs a `modules.runtime` line naming the directory and the modules it loaded and
failed to load. Then:

```bash
curl -s localhost:8080/api/ui | jq '.modules[] | select(.id == "maintenance")'
curl -s localhost:8080/api/providers/maintenance | jq .data
curl -s localhost:8080/api/health | jq .modules.maintenance
curl -s localhost:8080/api/ui | jq '.modules[] | select(.id == "maintenance") | .web'
curl -sI localhost:8080/modules/maintenance/web.js
```

Then open `/maintenance` in deck: the page, its nav entry and the header pill render from the
module's web half.
