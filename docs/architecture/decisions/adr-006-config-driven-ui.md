# ADR-006: Config-driven UI as one extension tree, resolved on the server

- Status: accepted
- Date: 2026-10-09

## Context

Before modules, the shell was fixed in code:

- the sidebar's groups and their order;
- the brand, the home page and the colour palette;
- which pills sat in the top bar;
- which cards sat on the portal.

Each feature registered its pages and fragments with paths, groups and orders written into the
web app. An operator who wanted a different home page, a hidden pill or a page of their own had
to fork.

The web also had no shared data layer. Several components fetched `/api/config` separately, the
header and the portal polled the same providers twice, and a page for a switched-off feature
could still show up in the nav. Once features became modules (ADR-005), their UI needed to be
data the kernel could place, not code each feature wired itself.

## Decision

**Every UI contribution is a node in one extension tree.** Pages, nav entries, top-bar pills and
actions, portal cards, entity-page sections and widgets each have:

- an id of the form `<kind>:<module>/<name>`, such as `page:inventory/hosts`,
  `pill:drift/summary` or `widget:ui/lab.hosts`;
- an attachment, `attachTo: { slot, order }`, to a slot that accepts their kind;
- a default `enabled` and a `config`.

Slots are declared too. `core` owns `app/…` and `entity:…`, and a module owns slots under its
own id (`portal/summary`). The web's registry calls are typed blueprints over this one model:
`registerWebModule` derives every registration from the manifest, and the web adds no paths,
slots or orders of its own.

**The server resolves the tree into a UI manifest.** `GET /api/ui` is built by a pure function
of the enabled modules' manifests and the `ui` config (`apps/server/src/ui/resolve.ts`). It
lists:

- modules, with a reason for each one that is off;
- the brand, the theme and the home page;
- nav groups and entries, pages (including config pages and their layouts), extensions;
- providers, widget types and status maps;
- findings.

The web shell renders from it: the manifest decides *which* components render, *where* and
*with what config*, and the web bundle supplies the components. Resolution is on the server so
that it is testable without a browser and identical for every client. Conflicts, such as two
claims on one id, slot or path, go to the incumbent, and problems become findings in the
manifest rather than a failed render.

**Operators shape it with an overlay-owned `ui` config section:**

- `brand`, `theme`, `home` and `nav` (group order and labels, extra links and separators);
- `extensions`, overrides by id;
- `pages` (dashboards) and `statusMaps`;
- the embed and framing switches.

An override **replaces** the default's `attachTo` and `config` wholesale and never deep-merges:
`false` hides a node, `true` shows it, and an object places or reconfigures it. Replace semantics
leave no doubt about the result of combining a default with an override.

**Theming is by named presets and tokens only.** `ui.theme` picks a preset (`teal`, `slate`,
`copper`, `rose`, `high-contrast`), a mode, a density and a radius. Config never names a colour,
so every preset stays inside the contrast suite (`apps/web/test/tokens-contrast.test.ts`), and
status keeps its meaning in every preset.

**Dashboards are pages → sections → widgets.** A section has 1–4 columns, and a widget spans
1–4 columns and 1–6 rows from the `md` breakpoint up. Below `md` every section is one column. A
free `x/y/w/h` grid was rejected: it pays off only with a drag-and-drop editor, which deck does
not have. In the section model, DOM order is reading order, which keeps the pages accessible.

**A widget is a typed descriptor**: `{ id, type, title?, source?, select?, options, span?, rows? }`.

- A widget **type** is a module contribution: an options JSON Schema, checked when config is
  validated, plus a component in the module's web half.
- `core` provides the generic types: `core/stat`, `core/table`, `core/list`, `core/markdown`,
  `core/embed` and the rest. They are pure renderers over `@/ui` patterns.
- `select` is a JMESPath expression evaluated **on the server**, under step, size and depth
  budgets, each time the provider's data changes. The results travel in the provider's envelope
  (`projections`), so the browser never runs the query engine.

The portal itself is a module page with a default dashboard (its summary slot, then one
`portal/groups` widget). An estate with no `ui` section renders exactly as it did before modules.

**One shared data layer.** The web reads server data through TanStack Query (`apps/web/src/data`):
`useConfig()`, `useUiManifest()` and `useProvider(id | { kind })`. Every reader of the same
resource shares one request per poll interval. A provider the manifest does not list is never
requested.

**The `ui` section reloads live.** The server watches the config directory:

- If only `ui` changed, it swaps the resolved manifest in place, with a new `ETag`, and open
  pages pick it up on refetch.
- If the directory no longer loads, it keeps serving the last good config and reports
  `UI_CONFIG_INVALID`.
- A change outside `ui` is `UI_RESTART_REQUIRED`, because module config is read only at boot.

## Consequences

- **No fork for most customisation.** An operator can rebrand, re-theme and rearrange the
  sidebar, hide or move any pill, card, section or page, choose the home page and build
  dashboards in YAML. `GET /api/ui` lists every id they can address.
- **Built-ins have no special path.** They place their UI with the same manifest data a runtime
  module or a sidecar uses (ADR-007). `apps/web/test/extension-ids.test.ts` and the server's
  `/api/ui` goldens hold the built-in ids and placements stable.
- **Most mistakes degrade, not fail.** An unknown override, a page on a taken path or a widget
  over a missing provider is a finding, and the rest renders. An invalid `ui` value (a widget
  option its type refuses, a malformed `select`) is still a schema error that `deck validate`
  reports and boot refuses, as for any other config.
- **The shell depends on the manifest.** Until it loads, the sidebar and slots are empty. If it
  cannot be read, the shell falls back to what the web registry declares. A boot object written
  into `index.html` (brand, theme mode, home) prevents a flash of the wrong theme or home page.
- **Data stays on the server.** `select` runs where the data is, bounded, so a widget cannot make
  the browser load or evaluate untrusted queries. The cost is that a new projection needs a
  server poll before it shows.
- **The palette is limited.** Operators get a fixed set of presets. A new preset is cheap to add
  to `theme.css`, but it must pass the contrast tests in both themes.

## Related

- [Customise the UI](../../guides/customise-the-ui.md)
- [Build a dashboard without code](../../guides/build-a-dashboard.md)
- [Estate configuration reference: `ui`](../../reference/estate-config.md#ui)
- [Widget types reference](../../reference/widget-types.md)
- [HTTP API reference: UI manifest](../../reference/http-api.md#ui-manifest)
- [Web UI architecture](../ui.md)
- [ADR-004: React 19, Tailwind CSS v4 and shadcn/ui for the web UI](./adr-004-web-ui-stack.md)
- [ADR-005: One module contract for every feature, around a small kernel](./adr-005-module-contract-and-kernel.md)
