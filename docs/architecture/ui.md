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

## Pages, the registry and the shell

Features register surfaces at import time. `registry/discover.ts` imports every
`features/*/index.ts`, and each one calls:

- `registerPage({ id, path, label, icon, group, component, nav? })` for a routed page;
- `registerEntityFragment({ id, entity, slot, component })` for a panel that appears on host or
  service detail pages (drift findings, owned configs);
- `registerSummaryFragment(HealthHeaderSlot, { id, component })` for a health pill in the top
  bar.

The shell builds itself from these registrations. The sidebar groups pages by `group` (Overview,
Inventory, Health, Operate, Knowledge) and marks the current section with
`aria-current="page"`. A detail route such as `/hosts/nas-01` keeps its list page active. The top
bar shows the page title, the health pills and the theme menu. There is exactly one
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
