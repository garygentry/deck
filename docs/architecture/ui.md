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

`ui.theme` picks a **preset** (`teal`, the default, `slate`, `copper`, `rose`,
`high-contrast`), a **density** and a **radius** by name; config never carries a colour. Each
non-default preset is a pair of `[data-theme-preset="…"]` blocks in `theme.css` (a light one and
a `.dark` one over the same tokens) that re-point tokens without touching the defaults, so the
default theme renders exactly as before. An accent preset's primary stays clearly apart from
every status tone (CIEDE2000 ≥ 15, or ≥ 30° of hue), so an accent never reads as a status.

Shape and spacing are layout tokens in `theme.css` too:

- **Radius:** `rounded-xs` … `rounded-xl` read the `--corner-*` scale, which
  `[data-theme-radius]` rescales (`none` is square). Round corners only from that scale (or
  `rounded-full`, `rounded-none`); a bare `rounded` or `rounded-[4px]` ignores the setting, and
  `test/ui-guardrails.test.ts` rejects it.
- **Density:** `DataTable`, `List`, `ListGroup`, `Section` and `EmptyState` take their spacing
  from tokens (`py-(--list-item-py)`, `p-(--section-card-p)`, …), which
  `[data-theme-density="compact"]` tightens. A spacing class a screen passes replaces the token
  class, so it stays as written. A new spacing-sensitive pattern should add its own tokens the
  same way.

Screens never read these settings.

Contrast is tested, not assumed. `test/tokens-contrast.test.ts` runs every preset in both
themes. It holds every text token to WCAG AA on every surface (7:1 for `high-contrast`, which
also holds controls to 4.5:1 and edges to 3:1), checks the destructive Button/Badge as rendered
(its alpha composited), and each feature's contrast test checks its maps only use those tokens.

The theme starts from one chain, `initialThemeMode` in `shell/theme-chain.ts`: the viewer's
choice from the theme menu (stored under `deck-theme-choice`), else an older shell's stored
`light` or `dark` (`deck-theme`, which it wrote on every load, so its `system` is ignored), else
the operator's default (`ui.theme.mode`), else system. A Vite plugin inlines that function into
`index.html` as the pre-paint script, so the page never flashes the wrong theme, and
`useThemeMode` calls the same function. The operator's default reaches the page in the boot
object the server writes into `index.html` (`DeckBoot` in `@deck/contract`, read with
`readDeckBoot`); only a choice made in the theme menu is stored. The pre-paint script also sets
the operator's preset, density and radius on `<html>` as `data-theme-preset`,
`data-theme-density` and `data-theme-radius` (`initialThemeAttributes`, in the same file); the
viewer does not choose those.

## Data

Server data reaches components through one shared cache, TanStack Query, in `src/data`. Import
the hooks from `@/data`:

- `useConfig()` gives the estate config as a `loading`/`ready`/`error` state. Every reader
  shares one `/api/config` request per page load. A failed or malformed read is not cached.
  It is asked again every poll interval until it succeeds, and readers keep showing the error
  while it is asked again.
- `useUiManifest()` gives the resolved UI manifest (`/api/ui`), also read once per page load,
  then again when the window regains focus and every minute. The server swaps the manifest
  when the `ui` config changes, and `App` shows its reload findings in a Callout. If it cannot
  be read, the answer is "unavailable" (an error state, with one console warning per failed
  read). Its readers ask again every poll interval until it succeeds, and they never drop back
  to loading meanwhile.
- `useProvider(id)` or `useProvider({ kind })` polls a provider's envelope on the shell
  interval. Every reader of the same provider shares one request per tick. A reader that joins
  within an interval of the last read reuses it. An envelope nobody has read for longer than an
  interval is dropped, so the next reader starts from loading. A provider the manifest does not
  list is never requested and reads as not configured. If the manifest is unavailable,
  providers are polled anyway.

A module route that is not a provider (llm-usage's `/api/llm-usage`) is polled on the same
client too: the feature's store owns a `QueryObserver` over its query, so every reader shares
one request per tick and the cache holds its last good answer. Its timing is the feature's own
(llm-usage polls only while read and visible, and stops once the server reports it off).

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
`features/*/index.ts`. A feature registers its module's web half (see "A module's web half"
below): where each page, nav entry, pill, card and entity section attaches is manifest data, so
a feature never hard-codes a path, slot, group or order. Pages, nav entries, `app/topbar.status`
pills, `portal/summary` cards and entity sections are all manifest-placed: declare them in the
module's `contributes`, never with a direct registry call.

The registry's blueprint calls (`registerPage`, `registerEntityFragment`,
`registerSummaryFragment`, `registerCard`, `registerExtension`) are the primitives
`registerWebModule` and core build on. Core uses them for its own controls (it registers the
theme menu, an `action` extension, and the dev-only `/_ui` workbench page, which no module
manifest lists), and tests use them for fixtures. No module's feature calls them.

Each registration is a blueprint over one model, the **extension**: a component with a stable id, attached
to a slot at an order. Ids have the form `<kind>:<module>/<name>`, and the kind matches the
blueprint: `page:inventory/hosts`, `pill:drift/summary`, `card:llm-usage/portal`,
`section:sources/host-configs`. A listed page also contributes its nav entry,
`nav:inventory/hosts`. The ids are the ones the server's UI manifest (`GET /api/ui`) lists, so
config can address an extension by id.

| Slot (accepts) | Declared in | Placed by | Host |
|---|---|---|---|
| `app/routes` (page), `app/nav` (nav) | `registry.ts` (core) | a manifest's `pages` and `nav` | the router; the sidebar (see below) |
| `app/topbar.status` (pill) | `registry.ts` (core) | a manifest `pill` extension | the health-header region |
| `app/topbar.actions` (action) | `registry.ts` (core) | a manifest `action` extension (core's theme menu is one) | the top bar's controls |
| `portal/summary` (widget) | the portal's `contributes.slots` | a manifest `widget` extension | the portal page's layout (`SlotWidgets`) |
| `entity:host/sections`, `entity:service/sections` (entity-section) | `registry.ts` (core) | a manifest `entity-section` extension | host and service detail pages |

The registry declares every core slot when it loads, from the list the server's UI manifest
gives core (`SHELL_SLOTS` in `@deck/contract/modules/core`), so nothing has to load before a
feature that attaches to one. The shell's slot modules only hand out typed handles
(`HealthHeaderSlot` types the status pills' payload).

### A module's web half

A module's UI contributions are data in its manifest: each page's path, title and icon, each
nav entry's group, each extension's slot, order and config, and the name of the component that
renders it. For a built-in module the server's manifest spreads that part in from
`@deck/contract/modules/<id>`, a data-only module the browser bundle can load (the web never
loads server code). The feature's `index.ts` pairs it with a component table and registers it:

```ts
import { LLM_USAGE_UI } from "@deck/contract/modules/llm-usage";
import { defineWebModule } from "@deck/module-sdk";
import { registerWebModule } from "../../registry/web-module.js";

registerWebModule(defineWebModule(LLM_USAGE_UI, {
  components: { LlmUsagePage, LlmUsageSummary, LlmUsagePortalCard },
}));
```

`registerWebModule` derives every registration from the manifest: a page per `pages` entry
(in its nav entry's group, or `nav: false` without one), a slot per `slots` entry, and an
extension per `extensions` entry, and a widget type per `widgetTypes` entry that names a
component (see "Config pages and widget types"). Widget descriptors (a `widget` and no
component) render through their widget type, not here.
The web adds no paths, slots or orders of its own. Everything is checked before anything
registers, so a refused module leaves nothing behind. It refuses, naming the module and the
component or extension: a name the manifest references that the table lacks (or holds
something other than a component under), a table entry nothing references, any other extension without a component, a nav entry it cannot express
(an `href` entry, one not named `nav:<page name>`, two for one page), a widget type outside
the module's namespace (`<module>/<name>`) or registered already, an extension (widget
descriptors included) on a core slot (`app/…`, `entity:…`) that core does not declare
(`UNKNOWN_SLOT`, instead of an orphan that never renders), and whatever the registry itself refuses (ids, paths, orders, slot kinds, entity-section config, duplicates). The
registrations are the defaults; at runtime the UI manifest still decides what renders, where
and with what config (below).

Labels and order: a page's `title` labels its route in the fallback nav. With a UI manifest, the
top bar and the document title name a page as the sidebar does: its nav entry's `label` (a
config page's `nav.label` relabels it), else the manifest's `title` for the page, else its
registered `title` (`routeLabel` in `shell/routes.ts`). The page's own heading stays its
`title`. A nav entry's `icon` shows only in the manifest-driven sidebar. Its `order` orders the
nav (the manifest's sidebar, and the fallback nav as the page's `navOrder`), never the routes.

Moving a feature onto it:
1. Move the module's `id`, `version`, `deckApi` and `contributes` to
   `packages/contract/src/modules/<id>.ts`, and spread it into the server manifest.
2. Replace the feature's `register*` calls with one `registerWebModule` per module it serves,
   and delete the placement constants (paths, slots, orders, group headings) from the web.
   Check the component table with `satisfies` against each slot's component contract (a pill
   takes `HealthSummary`). A feature imports nothing from the shell to attach to a core slot:
   the registry has declared them all.
3. Read module-route data through the shared query client (see "Data").
4. Keep the server UI goldens and `test/extension-ids.test.ts` unchanged; a registration
   test asserts the registry holds exactly the manifest's contributions, and a server test that
   the manifest takes them from the shared copy. A module that contributes no UI gets a
   server-side assertion that it has none.

A module declares the slots it hosts in `contributes.slots`, and `registerWebModule` defines
them (the portal's `portal/summary`). A slot id is namespaced to the module hosting it, and the
`app/…` and `entity:…` namespaces belong to `core`, whose slots the registry declares itself
(above). An extension attaches only to a slot that accepts its kind: a card is a `widget`, a
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
  whichever way it is registered (`registerWebModule`, `registerEntityFragment` or `registerExtension`).

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
and the marker `data-entity-slot="<section>"`. The UI manifest places the sections, like the
top bar's slots (`placeExtensions`, grouped by `groupEntitySections`): its order and each
entry's config (title, section) win, and a module that is off has no entries, so its sections
render nothing at all (no heading, no placeholder). With nothing attached, the pages show no sections. The naming rule is `entitySectionName` and the config rule `entitySectionProblem`, both
in `@deck/module-sdk`. The server validates the same config:
a manifest entity section without a title disables its module. For a `ui.extensions` override
whose replacement `config` is not a usable section, only the config is dropped, with
`UI_INVALID_OVERRIDE`; the rest of the override, such as `enabled: false`, still applies.

In development, discovery warns about any extension attached to a slot that nobody declared,
since it would never render.

The shell renders from the UI manifest (`useUiManifest()`); the registry supplies the
components:
- The sidebar lists the manifest's `navGroups` in order, each heading with its icon, and in each
  its `nav` entries, with their labels and icons. An entry to a page the web does not route is
  left out, and so is the page of a module that is off; so is an `href` that is neither an
  absolute in-app path nor `http(s)`. An `http(s)` entry (a `ui.nav.items` link) opens in a new
  tab with `ExternalLink` semantics (`ExternalLink plain` inside the menu button) and is never
  current. A `separator` entry is a `SidebarSeparator`, dropped at either end of a group or next
  to another, and a group left with no link is not shown.
- The top bar's slots (`app/topbar.status`, `app/topbar.actions`), the portal's summary cards
  (`portal/summary`, declared by the portal module's manifest) and the entity pages' sections
  render the manifest's entries for the slot, in its order, each with the web
  extension of the same id and kind and the entry's resolved `config` in place of the
  registered one (`placeExtensions`, `useManifestSlot(slot)`).
- The brand in the sidebar header and the document title (`"{page} · {brand}"`) is the
  manifest's `brand.title`. The sidebar mark beside it is `brand.logoUrl` as an image, else the
  `brand.icon`, else the title's initial (`brandMark`); a logo that fails to load shows the
  initial.
- `/` renders the home page, chosen by id (`resolveHome`): the manifest's `home` (`null`: no
  page is home, and `/` is not found); before the manifest is read, the boot object's `home`
  (so a configured home never flashes the portal first); without either, the portal's
  overview. It is the first route, so no page on `/` can take it, and it also stays routed at
  its own path. Its nav entry links to `/` and is current on either path, and the top bar and
  document title name it at `/`. No built-in page declares `/`. The not-found and
  module-not-enabled pages offer "Go to the home page" while some page is home.
- Routing follows the manifest too (`resolveRoutes`): a registered page of a module the
  manifest lists is routed only if the manifest routes it (lists it in `pages`), so no page of
  a disabled module, no page an override switches off and no page that lost its path is routed,
  and none can shadow another on its path. Each of
  the manifest's `disabledPages` renders `ModuleNotEnabledPage` at its path, naming every env var
  and config key that turns the module on (`modules[].enabledBy`, read leniently), or else the
  module's `reason`. Pages of modules the manifest does not list (the `_ui` workbench) are
  routed, and a manifest without `disabledPages` (an older server) routes every page. A
  disabled page whose path the router could not compile is dropped before the manifest is
  cached.

Until the manifest loads, the sidebar and those slots are empty, and every registered page is
routed. If it cannot be read, they fall back to the registry: the sidebar lists the registered
pages by their `group` (and `nav: false`), every registered page is routed, the slots render what
is registered there, and the brand is "Deck". So a page's registered `group` (its nav entry's
manifest group id, such as `health`) only matters in that fallback.

The registry is reactive. The shell's slot hosts call `useRegistryVersion()` and render what
the UI manifest places (`useManifestSlot(slot)`), reading the registry for the components.
`getCards(slot)` is the registry-only view of a widget slot, which serves only that fallback. Module code that wants the raw extensions of a
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

### Config pages and widget types

A config page (`ui.pages`) has no web component of its own: the UI manifest lists it as a page
of module `ui` with a `layout`, and the shell routes it (`shell/config-page/routes.tsx` turns
each into a page registration whose component reads the page from the manifest). `ConfigPage`
renders the layout: `PageHeader` (the one `h1`), a `Section` (`h2`) per section, and a
`data-slot="widget-grid"` grid that is one column below `md` and the section's `columns` from
`md` up. Column and row spans are static Tailwind class maps (`md:col-span-*`, `md:row-span-*`),
never `style={}`, and the grid never reorders, so DOM order is reading order.

Each widget renders in a `WidgetHost`: a card `Section` (`h3`, the widget's title, else its
type) whose body is chosen by `widgetView` from the widget, its type and its provider
(`useProvider(source.id)`): an `ErrorState` ("Widget unavailable") for a type the server says
no enabled module provides (`typeProblem`), that the manifest's `widgetTypes` does not list, or
that the web has not registered (it then reads no data), a source the server could not resolve
(`sourceProblem`), a provider without data because it failed, or a
`select` that failed on the data; a `LoadingState` until the first data; an `EmptyState` for a
null or empty value; else the type's component. A non-fresh provider adds a `FreshnessBadge`.
The body sits in a `FragmentBoundary` keyed on the envelope, so a widget that throws shows an
inline error and retries when new data arrives.

The body also sits in a `Suspense` boundary, so a type whose component loads on first use
(`core/table` and `core/markdown`, which keep TanStack Table and the markdown pipeline out of the
main bundle) shows a loading state in its own card while the rest of the page renders.

A widget type's component takes `WidgetProps`: `value` (the `select` result the server evaluated
into the envelope's `projections`, or the provider's data whole; `null` for a widget without a
source), `options` (already checked against the type's options schema at boot), `freshness` and
the placed `widget`. A module declares its types in `contributes.widgetTypes` (`type`,
`optionsSchema`, `component`, optionally the provider `sources` it renders) and puts the
components in its table; `registerWebModule` registers them (`registerWidgetType`). Deck's own
types are `CORE_WIDGET_TYPES` in `@deck/contract/modules/core`, registered by
`features/core-widgets`: `core/stat`, `stat-grid`, `meter`, `key-value`, `list`, `table`,
`status-grid`, `link-tiles`, `markdown`, `health-pills` and `json`. Their option schemas are
data in two copies that a test keeps equal: the contract's (`modules/widgets.ts`, so the browser
bundle needs no runtime import) and the schema library's, which config validation composes. Each is a pure renderer over `@/ui` patterns (`StatTile`,
`Meter`, `KeyValueList`, `List`, `DataTable`, `CardGrid` of `LinkTile`s, `Prose`, the top bar's
`HealthPill`s) that reads `field` paths of its value (never a query), formats values
(`features/core-widgets/values.ts`) and links only `http(s)` URLs (in a new tab) or absolute
in-app paths. Given a value it cannot show, it says so with a compact `ErrorState`. The
`markdown` widget renders through the docs view's pipeline, so DOMPurify is its XSS boundary
too.

Status in a widget comes from config, never from code: `ui.statusMaps` declares named maps
(exact `values` and ordered numeric `rules`, read by `statusTone` in `@deck/module-sdk`), the
UI manifest publishes them as `statusMaps`, and a widget's `statusMap` option names one
(`useStatusMaps`, `toneOf`). A toned value renders with the tone, its icon (`TONE_ICON`) and the
value's own text, so it is never colour alone. The workbench's "Dashboard widgets" section shows
every type, its maps passed through `StatusMapsOverride`.

The browser never evaluates a `select`: the JMESPath engine is only in
`@deck/schema/select`, which the server imports. `test/no-select-engine.test.ts` follows every
runtime import from `src/` through the workspace packages to keep it out of the web, and CI
greps the built bundle for it.

Config pages exist only in the manifest, so while it loads the shell shows a loading state, not
the portal or "not found", at `/` when the server's boot object names a config page as home,
and at any path no registered page matches.

### Module page dashboards: the portal

A module page may declare a default dashboard, `layout` in its `contributes.pages` entry:
sections that are a `{ slot }` the module hosts as a `widget` slot, or `{ widgets }` of
`{ id, type }` (the module's own types or core's, with no options and no source). The UI manifest
resolves it like a config page's (each widget is `widget:<module>/<page name>.<id>`, which an
override can switch off), and the page's component renders it with `usePageLayout` (the
manifest's layout, else the declared one while the manifest loads or when it cannot be read)
and `PageLayoutSections` (`shell/config-page/layout.tsx`): a slot section's widgets through
`SlotWidgets`, each in its own boundary, and each widget through a `WidgetHost` with
`placement="page"`, which has no card, title or span, so the widget is the page's own content.
A widget type's component gets the `placement`, so one that is a page's main list (the
portal's) listens for its keys on the window there, and only within itself on a dashboard.

The portal page is this: its `PageHeader`, then the `portal/summary` slot, then one
`portal/groups` widget (`features/portal/PortalGroupsWidget.tsx`: the filter bar and the
groups of cards). A config page can place `portal/groups` too, in a card, with a `groups`
option. A card's status comes from the UI manifest's `statusKinds`, the declarations of the
bindable, status-capable provider kinds (`providerKinds[].status`): `card-status.ts` reads the
first such binding of the service by kind name, finds the bound item in the provider's data and
checks its `up` conditions, so a new data source drives cards with no portal code.
`usePortalData` polls only the providers the placed cards read (`useProviders`), and falls back
to the built-in kinds' declarations (`@deck/contract/modules/data-sources`) when the manifest
cannot be read.

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
5. Declare it in the module's manifest (path, title, an `icon` from `ui/lib/icons.ts`, and a nav
   entry with its `group`), and add the component to the table `features/<name>/index.ts`
   registers (lazily via `pages.ts` if it pulls in heavy dependencies).
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
