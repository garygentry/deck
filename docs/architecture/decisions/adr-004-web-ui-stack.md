# ADR-004: React 19, Tailwind CSS v4 and shadcn/ui for the web UI

- Status: accepted
- Date: 2026-09-24

## Context

The first releases of the web app grew one feature at a time. Each feature brought its own
markup, its own section of a single global stylesheet, and its own copies of shared behaviour:
keyboard list navigation, filter state, age formatting and status presentation. Colours were CSS
variables named after domain states rather than meanings. Icons were CSS masks keyed by
attribute, and several state maps used unicode glyphs. The result worked but looked inconsistent,
and every new screen re-solved the same problems. There was also no reusable component for the
things deck shows most: tables, lists, trees and cards of estate entities.

The UI needed a durable baseline: a component library that features compose, with the
accessibility and status conventions built in once.

## Decision

Build the web UI on **React 19**, style it with **Tailwind CSS v4**, and base the component
library on **shadcn/ui**:

- React 19 gives the widest ecosystem of accessible headless components (Radix), a mature testing
  story (React Testing Library), and `React.lazy`/`Suspense` for route-level code splitting.
- Tailwind CSS v4 styles components from design tokens with utility classes. There is no global
  stylesheet to grow per feature, and cascade layers keep Preflight, component CSS and utilities
  in a predictable order.
- shadcn/ui components are vendored source, not a dependency, so deck owns and can edit them.
  They are built on Radix primitives with correct ARIA and keyboard behaviour.

On top of the primitives, deck keeps its own pattern layer (`@/ui`: `StatusBadge`, `DataTable`,
`FilterBar`, `TreeView`, …) and a tone vocabulary (`ok`, `warn`, `danger`, `info`, `pending`,
`neutral`) that features map their states onto. The supporting choices are Lucide icons through a
curated registry, TanStack Table under `DataTable`, wouter for routing, self-hosted Geist fonts,
and OKLCH tokens with class-based dark mode.

## Consequences

- Every screen shares one look and one set of behaviours. A fix in a pattern, such as a keyboard
  guard or a contrast adjustment, reaches every page that uses it.
- Colour is always a tone, never a literal, and every status carries an icon and text. Contrast is
  tested against the token set in both themes.
- Meta tests enforce the conventions: barrel-only imports, no colour literals, `data-slot` roots,
  and no legacy icon attributes. Visual baselines for the workbench and every page are verified in
  CI.
- The main JavaScript bundle is larger than a Preact build would be. Route-level lazy loading
  keeps heavy dependencies (markdown rendering, syntax highlighting, the table engine) out of it,
  but React itself is a fixed cost.
- Vendored primitives must be updated by hand. Local edits are commented at the top of each file,
  so a later `shadcn diff` stays readable.
