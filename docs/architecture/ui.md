# Web UI: stack, component library, and conventions

The web app (`apps/web`) is a React 19 single-page app built with Vite and styled with
Tailwind CSS v4. Every screen is composed from one in-repo component library, `@/ui`, so pages
share one look, one set of status colours, and one set of accessibility behaviours. The decision
behind this stack is recorded in [ADR-004](./decisions/adr-004-web-ui-stack.md).

## Layers

```
apps/web/src/
  ui/
    primitives/   vendored shadcn/ui source (Radix-based): Button, Table, Sidebar, Tooltip, …
    patterns/     deck composites: StatusBadge, DataTable, FilterBar, TreeView, PageHeader, …
    hooks/        useListNavigation, useFacetFilters, useScrollToHash, useDocumentTitle, …
    lib/          cn(), icons.ts (curated Lucide set), status.ts (tones), format.ts, filters.ts
    index.ts      the public barrel: feature code imports from "@/ui"
  shell/          AppShell, AppSidebar, Topbar, ThemeMenu, NotFoundPage, the health header
  features/*/     one directory per feature; `index.ts` registers pages and fragments
  styles/         app.css (Tailwind entry + base rules), theme.css (tokens), hljs.css
```

- **Primitives** are shadcn/ui components, copied into the repo rather than installed. They
  belong to deck and may be edited; each local edit is noted in a comment at the top of the file.
- **Patterns** are deck's own components built on the primitives. They carry the product's
  decisions: never colour-only status, a labelled region for every scrolling table, one `h1` per
  page, and so on.
- **Hooks and lib** hold behaviour that has no markup: keyboard navigation, filter state, time
  formatting, and the tone vocabulary.
- **Features** compose patterns and hold domain logic. A feature imports UI only from the barrel.
  A deep import of a primitive is allowed only with a `// ui-deep-import: <why>` comment, and
  a meta test enforces this.

## Tokens and tones

`styles/theme.css` defines every colour as a CSS variable in OKLCH, for light (`:root`) and dark
(`.dark` on `<html>`). There are two groups:

- the shadcn semantic tokens (`--background`, `--foreground`, `--primary`, `--muted`,
  `--border`, `--input`, `--ring`, …), with a teal primary;
- six **status tones**: `ok`, `warn`, `danger`, `info`, `pending` and `neutral`. Each has an
  `-fg`, `-bg` and `-border` variant (for example `--status-warn-fg`), exposed to Tailwind as
  `text-status-warn-fg`, `bg-status-warn-bg` and so on.

A feature never picks a colour. It maps its domain states to tones with `defineStatusMap`, and
every state carries an icon and a label:

```ts
export const OUTCOME_UI = defineStatusMap<ActionOutcome>({
  succeeded: { tone: "ok", icon: "circle-check", label: "Succeeded" },
  failed: { tone: "danger", icon: "circle-x", label: "Failed", role: "alert" },
  // …
});
// Rendered with <StatusBadge {...OUTCOME_UI[outcome]} /> or StatusBadge.fromMap(OUTCOME_UI, outcome).
```

Contrast is tested, not assumed. `test/tokens-contrast.test.ts` holds every text token to WCAG AA
on every surface in both themes, and each feature's contrast test checks its maps only use those
tokens.

The theme follows the stored preference (light, dark or system). An inline script in
`index.html` applies it before first paint, so the page never flashes the wrong theme.

## Data

Server data reaches components through one shared cache, TanStack Query, in `src/data`. Import
the hooks from `@/data`:

- `useConfig()` gives the estate config as a `loading`/`ready`/`error` state. Every reader
  shares one `/api/config` request per page load. A failed or malformed read is not cached.
  It is asked again every poll interval until it succeeds, and readers keep showing the error
  while it is asked again.
- `useUiManifest()` gives the resolved UI manifest (`/api/ui`), also read once. If it cannot
  be read, the answer is "unavailable" (an error state, with one console warning per failed
  read). Its readers ask again every poll interval until it succeeds, and they never drop back
  to loading meanwhile.
- `useProvider(id)` or `useProvider({ kind })` polls a provider's envelope on the shell
  interval. Every reader of the same provider shares one request per tick. A reader that joins
  within an interval of the last read reuses it. An envelope nobody has read for longer than an
  interval is dropped, so the next reader starts from loading. A provider the manifest does not
  list is never requested and reads as not configured. If the manifest is unavailable,
  providers are polled anyway.

Code outside React (the inventory store) reads through the same client: the cached config,
and `isProviderPollable(id)`. While other readers hold a failing config, the store reports the
failure without forcing a refetch; the shared query owns the retry. Feature code never fetches
config or provider envelopes itself.

The cache keeps deck's timing:
- no automatic retries;
- no refetch when the tab regains focus;
- updates are delivered on a microtask, so a paused clock in a test or a visual capture never
  holds back a render.

## Pages, the registry and the shell

Features register surfaces at import time. `registry/discover.ts` imports every
`features/*/index.ts`, and each one calls:

- `registerPage({ id, path, label, icon, group, component, nav? })` for a routed page;
- `registerEntityFragment({ id, entity, title, section?, order?, component })` for a section on
  host or service detail pages (drift findings, owned configs; see "Entity sections" below);
- `registerSummaryFragment(HealthHeaderSlot, { id, component })` for a health pill in the top
  bar;
- `registerCard({ id, slot, component })` for a card in a host's card slot (the portal summary).

Each call is a blueprint over one model, the **extension**: a component with a stable id, attached
to a slot at an order. Ids have the form `<kind>:<module>/<name>`, and the kind matches the
blueprint: `page:inventory/hosts`, `pill:drift/summary`, `card:llm-usage/portal`,
`section:sources/host-configs`. A listed page also contributes its nav entry,
`nav:inventory/hosts`. The ids are the ones the server's UI manifest (`GET /api/ui`) lists, so
config can address an extension by id.

| Slot (accepts) | Blueprint | Host |
|---|---|---|
| `app/routes` (page), `app/nav` (nav) | `registerPage` | the router; the sidebar (see below) |
| `app/topbar.status` (pill) | `registerSummaryFragment(HealthHeaderSlot, …)` | the health-header region |
| `app/topbar.actions` (action) | `registerExtension` | the top bar's controls (the theme menu) |
| `portal/summary` (widget) | `registerCard` | the portal page |
| `entity:host/sections`, `entity:service/sections` (entity-section) | `registerEntityFragment` | host and service detail pages |

A slot is declared with `defineSlot({ id, accepts, module })`. Its id is namespaced to the
module hosting it (`portal/summary`), and the `app/…` and `entity:…` namespaces belong to
`core`. An extension attaches only to a slot that accepts its kind: a card is a `widget`, a
pill a `pill`, an entity fragment an `entity-section`. A mismatch throws at registration,
whichever of the slot and the extension is declared first.

Registration follows the same rules as the server's manifest validation, shared through
`@deck/module-sdk`:
- slot names and ids are checked the same way;
- orders must be finite;
- a page path must be a route pattern the router can compile (`routablePathProblem` mirrors its
  parser, so a stray `[` or `(` is refused);
- a page path may not sit under `/api` or on a root path the kernel or a built-in module serves,
  such as the metrics module's `/metrics` (`BUILTIN_ROOT_PATHS`);
- every extension but a nav entry needs a component;
- an entity section needs a title, and a section it names is lowercase (`a-z`, `0-9`, `-`) with no
  `.`,
  whichever way it is registered (`registerEntityFragment` or `registerExtension`).

### Entity sections

The host and service detail pages are open: they render whatever is attached to
`entity:host/sections` or `entity:service/sections`, and own no list of sections. A module
attaches a section by its extension id. Its config (the manifest extension's `config`, or the
registration's fields) carries:
- `title`: the section's heading, required;
- `section`: the section it shares, optional: lowercase `a-z`, `0-9` and `-`, with no `.`.
  Extensions that name the same section, from any module, render together under the heading of
  the first one by order. Without it, the extension has its own section, named `<module>.<name>`
  from its id (`section:backups/host` → `backups.host`). Its own section cannot be joined,
  because dotted names are reserved for it: `section: "backups.host"` is refused. Two modules'
  extensions with the same name never merge, and an extension's own section never joins a shared
  one such as `findings` by accident.

Sections render in the order of their first extension, then by id. The built-ins name their
sections explicitly and place drift's `findings` at order 10 and sources' `configs` at order 20, so a module's section at order 15
renders between them. Each section is a `Section` with the heading id `entity-slot-<section>`
and the marker `data-entity-slot="<section>"`. With nothing attached, the pages show no
sections. The naming rule is `entitySectionName` and the config rule `entitySectionProblem`, both
in `@deck/module-sdk`. The server validates the same config:
a manifest entity section without a title disables its module. For a `ui.extensions` override
whose replacement `config` is not a usable section, only the config is dropped, with
`UI_INVALID_OVERRIDE`; the rest of the override, such as `enabled: false`, still applies.

In development, discovery warns about any extension attached to a slot that nobody declared,
since it would never render.

The shell renders from the UI manifest (`useUiManifest()`); the registry supplies the
components:
- The sidebar lists the manifest's `navGroups` in order, and in each its `nav` entries, with
  their labels and icons. An entry to a page the web does not route is left out, and so is the
  page of a module that is off.
- The top bar's slots (`app/topbar.status`, `app/topbar.actions`) render the manifest's entries
  for the slot, in its order, each with the web extension of the same id and kind
  (`useManifestSlot(slot)`).
- The brand in the sidebar header and the document title (`"{page} · {brand}"`) is the
  manifest's `brand.title`.
- Routing follows the manifest too (`resolveRoutes`): no registered page of a module the
  manifest lists as disabled is routed, so none can shadow an enabled page on its path. Each of
  the manifest's `disabledPages` renders `ModuleNotEnabledPage` at its path, naming every env var
  and config key that turns the module on (`modules[].enabledBy`, read leniently), or else the
  module's `reason`. Pages of modules the manifest does not list (the `_ui` workbench) are
  routed, and a manifest without `disabledPages` (an older server) routes every page. A
  disabled page whose path the router could not compile is dropped before the manifest is
  cached.
  A page switched off by a `ui.extensions` override is left out of the nav, but the web still
  routes it.

Until the manifest loads, the sidebar and the top bar's slots are empty, and every registered
page is routed. If it cannot be read, they fall back to the registry: the sidebar lists the
registered pages by their `group` (and `nav: false`), every registered page is routed, the slots
render what is registered there, and the brand is "Deck". So
`registerPage`'s `group` only matters in that fallback.

The registry is reactive. The shell's slot hosts call `useRegistryVersion()` and read their
blueprint view (`getPages()`, `getCards(slot)`, …). Module code that wants the raw extensions of a
slot uses `useSlot(slot)`, which returns the same array until the next registration. Either way,
an extension registered after first render appears without a reload, for example one from a
lazily loaded module.

Every slot host renders each extension inside a `FragmentBoundary`, so one that throws shows a
compact fallback instead of blanking its host. The boundary resets on a key:
- a page's slot host (`useSlotResetKey`) uses the path plus the provider poll tick;
- the persistent top bar (`usePollResetKey`) uses the poll tick alone.

An extension that threw tries again at the next poll, once its data may have recovered, or after
navigation on a page.

The sidebar marks the current section with `aria-current="page"`. A detail route such as
`/hosts/nas-01` keeps its list page active. The top bar shows the page title, the health pills
and the theme menu. There is exactly one
`<main id="main">`, reached from a skip link.

Heavy pages load on first visit. A feature's `pages.ts` wraps its page components in
`React.lazy`, and the shell's `Suspense` boundary shows a `LoadingState` meanwhile. So
markdown-it, DOMPurify, highlight.js and TanStack Table stay out of the main bundle. The dev-only
component workbench (`/_ui`) is a lazy import inside an `import.meta.env.DEV` branch, so none of it
ships.

## Adding a page

1. Create `features/<name>/` with the page component. Give its root element
   `data-slot="<name>-page"`.
2. Compose it from `@/ui`: `PageHeader` for the single `h1`, `Section` for each `h2` region, and
   the pattern that fits the content (`DataTable`, `List`, `CardGrid`, `KeyValueList`, …).
   Use `LoadingState`, `EmptyState` and `ErrorState` (or `ConfigGate`) for the non-happy
   paths, and `PageErrorBoundary` around the page.
3. Map domain states with `defineStatusMap`; render them with `StatusBadge`.
4. For keyboard list navigation use `useListNavigation`. Its editable-field guard and
   modifier-key passthrough are built in.
5. Register it in `features/<name>/index.ts` (lazily via `pages.ts` if it pulls in heavy
   dependencies), with an `icon` from `ui/lib/icons.ts` and a nav `group`.
6. Test the accessibility contract with React Testing Library role queries, and add a
   `test/e2e/visual-<name>.spec.ts` (see below).

## Adding a pattern

Put it in `ui/patterns/<kebab-name>.tsx`, export it from `ui/index.ts`, and:

- give its root element `data-slot="<kebab-name>"`;
- style it only with token classes: no hex, `rgb()` or `oklch()` literals, and `style={…}`
  only for dynamic geometry (listed in the guardrail allowlist);
- use `<Icon name="…">` with a curated name, adding the Lucide icon to `ui/lib/icons.ts` by name
  if needed;
- show it in every state in the workbench (`features/_ui/sections/<group>.tsx`) and cover its
  a11y contract in `test/ui-<group>.test.tsx`.

`test/ui-guardrails.test.ts` enforces the mechanical parts: barrel imports, no colour literals,
the `style=` allowlist, `data-slot` roots, no `data-icon`, and no legacy tokens.

## Testing and visual baselines

- **Unit:** Vitest with jsdom and React Testing Library, asserting roles, names and ARIA states
  rather than markup. `DataTable` calls a column's `cell` renderer as a plain function, so a
  `cell` must not call hooks (render a component from it instead).
- **E2E:** Playwright against the Vite dev server and a Bun fixture API. Set
  `DECK_E2E_WEB_PORT` and `DECK_E2E_API_PORT` to run two suites side by side.
- **Accessibility:** `test/e2e/a11y.spec.ts` runs axe (WCAG 2.1 A/AA) on every route in both
  themes and fails on any serious or critical violation. It also checks the skip link and
  keyboard navigation.
- **Visual regression:** the `visual-*.spec.ts` specs and `ui-workbench.spec.ts` take full-page
  `toHaveScreenshot` snapshots at 375, 768 and 1280 px in light and dark. They hide the shell,
  freeze the clock and pin time-dependent data. Baselines are generated and verified **only on CI
  Linux**, because font rasterisation differs between machines, so locally these tests skip
  unless `UPDATE_VISUALS` is set. To refresh baselines after an intended visual change, run the
  `ci` workflow manually with `update_visuals`, then commit the downloaded artifact:

  ```sh
  gh workflow run ci.yml --ref <branch> -f update_visuals=true
  gh run download <run-id> -n visual-baselines -D apps/web/test/e2e
  ```
