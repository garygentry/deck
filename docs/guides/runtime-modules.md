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
and light or dark mode.

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
whatever the web half says. The web half supplies the components.

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
is read-only to deck. It is not a defence against someone who can write to the directory
while deck starts: files a module imports later are read after the digest is taken.

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
  a provider kind, a health key, a route or path (`collision`);
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
