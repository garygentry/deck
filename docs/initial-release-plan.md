# deck — Initial Release Plan (→ v0.1.0)

**Goal:** take deck from its first-run baseline to a *fairly stable initial release* —
one that runs for real in a home lab, shows meaningful data across every surface, is
deployable and documented, and is clean enough to start refining and polishing.

**Baseline (done, on `main`):** the app builds, runs in one command (`pnpm dev` /
`pnpm start`), is styled with a light/dark/system theme, renders icons, is
`/code-review`-clean, and CI is green. See PR #1 (merge `fc4eb46`).

---

## How to use this plan (read this first, every session)

This file is the single source of truth for the release effort and is designed to
survive across sessions and `/clear`s. To make progress:

1. **Read** this file top-to-bottom, plus the memory note `deck-baseline-first-run`
   for context on what already shipped and why.
2. **Pick the next unchecked item** in priority order (P0 before P1, and top-to-bottom
   within a priority). Don't skip ahead unless an item is blocked — if blocked, note
   why in the Progress Log and take the next actionable item.
3. **Branch** off `main` (`git checkout -b <type>/<slug>`), do the work, and verify:
   - tests green (`pnpm -r test` or the affected workspace),
   - browser-verified where UI changes (light **and** dark, mobile 375px; screenshots
     to `./screenshots`, which is gitignored),
   - CI green on the branch.
4. **PR into `main`** (`gh pr create`), and after merge:
   - **tick the checkbox** for the item in this file (and any sub-items),
   - **append a dated entry** to the Progress Log with the commit/PR and any decisions,
   - update the `deck-baseline-first-run` memory note if a durable fact changed.
5. **One item per PR** where practical, so the plan stays legible and revertible.

**Status legend:** `[ ]` todo · `[~]` in progress · `[x]` done · `[!]` blocked (see log).
Keep this file honest — an unchecked box means not-verified-done.

**Definition of Done for v0.1.0** (all must be true):
- Runs via a documented container/deploy path against a real estate config.
- Shows meaningful data on Portal, Hosts, Services, Drift, Monitoring, Docs/Configs
  (not just empty states) given a configured estate + snapshot.
- No uncaught console errors on any route with a normally-configured estate.
- Deploy guide + estate-config authoring guide exist.
- CI green; tagged `v0.1.0` with a CHANGELOG.

---

## Priorities at a glance

| Priority | Theme | Why it's here |
| --- | --- | --- |
| **P0** | Real data + honest behavior | Today only Portal shows data; every other surface is empty. Fix the demo/first-run truth and the console noise. |
| **P1** | Deploy & document | Move from "runs on my machine" to "runs in the home lab," with the docs to configure it. |
| **P2** | Close core feature gaps | The known missing pieces (private-repo sources, snapshot ingestion story). |
| **P3** | Polish & performance | Bundle size, icon/edge coverage, visual refinement. |
| **P4** | Release hardening | Auth posture, observability, CI time, cut v0.1.0. |

---

## P0 — Real data & honest behavior

> Without these the app looks broken/empty on 6 of 7 surfaces and logs errors. Highest leverage.

- [x] **A1 — Example snapshot + richer example estate (data on every surface)**
  - *Problem:* `examples/estate/` declares only hosts/services/groups → Portal renders,
    but Hosts/Services show "No snapshot", Drift/Monitoring/Docs/Configs are empty. First
    run looks hollow and most code paths are unexercised by the default config.
  - *Approach:* author an example snapshot JSON (schema: `{ schemaVersion, generatedAt,
    hosts:[{name, coverage, collectedAt, reachable, ...}] }` — see
    `packages/schema/src/fixtures/primary/snapshot.*.json`) covering the example hosts
    with a mix of fresh/stale/partial states; add example `sources` (a local markdown
    tree under `examples/`), and optionally example `integrations`/`actions`. Wire
    `DECK_SNAPSHOT_SOURCE` (+ any `DECK_SOURCES_*`) into `pnpm dev`/`start` so the
    default config shows real inventory, drift, and docs out of the box.
  - *Acceptance:* `pnpm dev` shows non-empty Hosts/Services inventory with freshness,
    a non-empty Drift view, and at least one working Docs/Configs source — all against
    committed example data, no network required. Validated in-browser.
  - *Size:* M.

- [x] **A2 — Provider-404 gating (stop the console errors, make polling honest)**
  - *Problem:* the web polls a fixed set of `/api/providers/*` (docker, gatus,
    prometheus, alertmanager, snapshot) regardless of what the estate declares, so a
    minimal config logs ~7 console 404s. Handled gracefully (empty states) but noisy
    and misleading.
  - *Approach:* **decide the model first** (record the decision in the log): (a) gate
    each poll on whether the config declares that binding/integration/snapshot;
    (b) add a server `GET /api/providers` index the web reads to poll only registered
    providers; or (c) treat "not configured" as a first-class non-error server response.
    Then implement across `usePortalData`, `inventory-store`, and the alerts-and-health
    hooks.
  - *Acceptance:* a normally-configured estate produces **zero** provider 404s in the
    console; not-configured providers still render their empty/"not configured" state.
  - *Size:* M. *Note:* this is a design decision — do A2's decision step before coding.

- [x] **A3 — Full-surface browser verification pass**
  - *Problem:* many surfaces have never been seen with real data.
  - *Approach:* with A1's data in place, walk every route in light + dark + mobile;
    capture screenshots; file any rendering/interaction bugs as new plan items (P3).
  - *Acceptance:* every route renders correctly with data; issues logged.
  - *Size:* S.

- [x] **A4 — `/actions` 403 console error when actions are disabled** *(found during A2)*
  - *Problem:* governed actions are safe-by-default **disabled** (`DECK_ACTIONS_ENABLED`
    unset), so `/actions` polling `/api/actions/audit` logs a console **403** on a
    normally-configured estate. Same class as A2 (a capability polled when off), but a
    separate subsystem — not a provider, so not covered by the `/api/providers` index.
  - *Approach:* let the web learn the actions capability is off without a 403 — e.g. a
    lightweight capability flag the web reads (a `/api/actions` index/health, or fold an
    `actions: { enabled }` into an existing surfaced response), then gate `ActionsPage`
    polling on it. Renders the same disabled state without the request.
  - *Acceptance:* `/actions` produces **zero** console errors when actions are disabled;
    the disabled state still renders; enabled actions unaffected. (Feeds the v0.1.0 DoD
    "no uncaught console errors on any route.")
  - *Size:* S.

---

## P1 — Deploy & document

> Turn a dev-only app into something you can actually run in the home lab.

- [x] **B1 — Container image (Dockerfile) + compose example**
  - *Problem:* no deployment artifact exists; the only run paths are dev scripts.
  - *Approach:* multi-stage Dockerfile — build the web (`vite build`) and run the
    Bun server serving `dist` + `/api` (`DECK_WEB_DIST`), with the estate config mounted
    as a volume (`DECK_CONFIG_DIR`). Add `.dockerignore` and an `examples/compose.yaml`
    showing config/snapshot volumes, ports, and env. Pin the Bun base image.
  - *Acceptance:* `docker build` + `docker run` (config volume mounted) serves the app
    + API on a port; documented one-liner works against `examples/estate`.
  - *Size:* M.

- [x] **B2 — Deployment & operations guide**
  - *Approach:* `docs/deploying.md` — env vars (`DECK_CONFIG_DIR`, `DECK_PORT`,
    `DECK_WEB_DIST`, `DECK_SNAPSHOT_SOURCE`, `DECK_SOURCES_*`, actions envs), ports,
    volumes, the reverse-proxy assumption (see E1), health endpoint, and how to refresh
    the snapshot.
  - *Acceptance:* a new operator can deploy from the guide alone.
  - *Size:* S.

- [x] **B3 — Estate-config authoring guide**
  - *Approach:* `docs/configuring-your-estate.md` — how to write an estate: hosts,
    services, groups, sources, integrations, actions, overlays/layering, validation
    (`deck validate`), referencing `examples/estate/`.
  - *Acceptance:* a user can author a working estate from the guide + examples.
  - *Size:* M.

---

## P2 — Close core feature gaps

- [x] **C1 — `sources[].credentialEnv` + private-repo source auth** *(already shipped; verified)*
  - *Problem:* long-standing schema gap — `integrations[].credentialEnv` exists but
    `sources[]` has no credential reference, so private git-repo sources can't auth.
  - *Approach:* add `credentialEnv` to the `Source` schema in `packages/schema`
    (estate-contract), thread it through the sources acquisition/spawner path so a git
    clone can use the referenced env credential. **Consider running this as a
    feature-forge feature** (`/feature-forge:forge-1-prd source-credential-env`) since it
    touches the contract + server + tests.
  - *Acceptance:* a private-repo source clones using a credential from `credentialEnv`;
    schema + validation + tests updated.
  - *Size:* M–L.

- [x] **C2 — Snapshot ingestion story (how observed reality is produced)**
  - *Problem:* Drift/inventory depend on a snapshot, but there's no documented/example
    way to *produce* one from a real estate (only fixtures + `DECK_SNAPSHOT_SOURCE`).
  - *Approach:* document the snapshot contract and a reference way to generate/refresh
    one (script or cron pattern); tie into B2. Decide scope — doc-only vs a helper.
  - *Acceptance:* an operator understands how to keep the snapshot current.
  - *Size:* S–M (doc-first).

---

## P3 — Polish & performance

- [x] **D1 — Web bundle code-split**
  - *Problem:* one 1.27 MB JS chunk (427 KB gz). Fine for LAN, but easy wins exist.
  - *Approach:* lazy-load feature routes / split vendor (markdown-it, highlight.js,
    dompurify) via dynamic import + `manualChunks`. Target initial chunk < 500 KB.
  - *Acceptance:* initial route loads a smaller chunk; no route regressions.
  - *Size:* S–M.

- [x] **D2 — Icon coverage & fallback**
  - *Problem:* config-supplied / dynamic `data-icon` names (e.g. `group.icon`,
    `match.kind`) that aren't in `icons.css` render as an empty box.
  - *Approach:* add a neutral fallback glyph for unknown `[data-icon]`, and audit the
    dynamic name sources to cover the common set.
  - *Acceptance:* no invisible/empty icon slots for realistic configs.
  - *Size:* S.

- [x] **D3 — Visual polish pass** *(scoped to the A3 stagger finding)*
  - *Approach:* empty-state affordances, spacing/typography rhythm, responsive edge
    cases, focus-ring consistency, table density on mobile. Drive from A3's findings.
  - *Acceptance:* a cohesive, refined feel across surfaces in both themes.
  - *Size:* M (iterative).

- [ ] **D4 — Architecture docs backfill (optional)**
  - *Problem:* only 3 of 8 members have architecture docs (6 were docs-skipped to close
    the epic).
  - *Approach:* `/feature-forge:forge-6-docs <member>` for the undocumented members, or
    hand-write concise docs.
  - *Acceptance:* each core subsystem has a short architecture doc. *Nice-to-have.*
  - *Size:* M.

---

## P4 — Release hardening (cut v0.1.0)

- [x] **E1 — Auth / access posture** *(doc-only: reverse-proxy model)*
  - *Approach:* decide + document the access model. Simplest: document the
    "run behind an authenticating reverse proxy" assumption; optionally add opt-in
    basic auth. Actions are already safe-by-default (disabled).
  - *Acceptance:* the access posture is explicit and documented.
  - *Size:* S (doc) / M (if implementing auth).

- [x] **E2 — Error handling & observability review**
  - *Approach:* audit server error paths + UI error boundaries; confirm structured logs
    are useful; decide if any metrics endpoint is wanted for v0.1.0.
  - *Acceptance:* failures degrade gracefully and are diagnosable.
  - *Size:* S–M.

- [x] **E3 — CI e2e time optimization**
  - *Problem:* `node-pnpm` is ~11 min (full Playwright e2e).
  - *Approach:* shard e2e, cache browsers, or split unit/e2e into parallel jobs.
  - *Acceptance:* meaningfully faster CI without losing coverage.
  - *Size:* S.

- [x] **E4 — Cut v0.1.0** 🎉
  - *Approach:* version bump across workspaces, `CHANGELOG.md`, tag `v0.1.0`, release
    notes. Confirm the Definition of Done above is met.
  - *Acceptance:* tagged release; DoD checklist satisfied.
  - *Size:* S.

---

## Progress Log (append-only, newest last)

- **2026-09-19** — Plan created on `main`. Baseline shipped via PR #1 (`fc4eb46`):
  run wiring, stylesheet + theme toggle, icon masks, review fixes, and three CI fixes
  (pnpm version conflict, boot-smoke `ok|degraded`, Bun in `node-pnpm`). CI green.
  Merged branch `integration/first-run` deleted. Next up: **A1** (example data).

- **2026-09-19** — **A1 done** (PR #2, squash `35c704a`). Enriched `examples/estate/`
  to 5 hosts + 6 services; added `snapshot.template.json` + `scripts/make-example-snapshot.mjs`
  (regenerates `examples/estate/.runtime/snapshot.json`, gitignored, with now-relative
  timestamps — deck derives freshness from the wall clock, so a static snapshot would age
  to "stale"); declared local `markdown-tree` (Docs → `examples/estate/docs`) and `file-tree`
  (Configs → `examples/estate/configs`) sources in the overlay; wired `pnpm dev`/`start` to
  run `pnpm snapshot:example` and default `DECK_SNAPSHOT_SOURCE`. Decisions: (1) generator over
  a static snapshot, for a durable fresh/stale/partial mix; (2) `sources`/`estate.freshness`
  live in the overlay, not base (overlay-owned per `ownership.ts`); (3) **integrations/actions
  left out on purpose** — their live-URL polls would add provider-404 noise that A2 exists to
  fix. Hosts/Services/Drift/Docs/Configs now render real data; verified in-browser
  (light/dark/mobile), unit + e2e green, CI green. Next up: **A2** (provider-404 gating).

- **2026-09-19** — **A2 done** (PR #3, squash `e284cb6`). **Decision:** providers-index
  model (option b) — added `GET /api/providers` returning the registry's `[{id,kind}]`;
  the web fetches it once (memoized, `shell/providers-index`) and the portal/prometheus/
  alertmanager/inventory hooks skip any provider absent from the index (a `null` result
  renders the same not-configured state, no request). A failed index read → `null` →
  poll-anyway fallback, so a transient discovery failure never hides a configured
  provider. Chose it over gate-on-config (can't see the env-driven snapshot; duplicates
  registration rules) and server-200 (keeps wasteful polling, muddies 404). Verified:
  **zero provider 404s** across all routes on the example estate; not-configured states
  unchanged. Unit web 1055 / server 593, e2e 91, CI green. **Discovered:** a `/actions`
  403 when actions are disabled — logged as new item **A4** (separate capability, not a
  provider). Next up: **A3** (full-surface browser verification) or **A4**.

- **2026-09-19** — **A3 done** (verification-only; no code, so no PR). Swept all 10
  routes (8 nav + `/hosts/:name`, `/services/:host/:name`) at desktop 1280 + mobile 375,
  light + dark, on the example estate. **Every surface renders correctly with real
  data**, including the two detail routes (declared-vs-observed, scoped drift, cross-links)
  seen for the first time. Interactions verified: hosts search/filter, host-detail
  navigation, drift severity filter — no pageerrors. **Only error across the whole sweep:**
  the `/actions` 403 already filed as **A4**. One cosmetic note (desktop declared/observed
  cards stagger diagonally, leaving whitespace) → feeds existing **D3**, not a bug; no new
  items filed. Next up: **A4** (the /actions 403) closes out P0, then P1 (B1 Docker).

- **2026-09-19** — **A4 done** (PR #4, squash `73fa94c`) — **P0 complete**. Added
  `GET /api/actions` capability probe (HTTP 200 with `{enabled}` either way, no 403);
  `ActionsPage` probes it on mount (failure → enabled fallback), flips to read-only
  proactively when disabled, and reads the audit log only once enabled — `AuditHistory`
  gained an `enabled` prop that skips the fetch and shows a disabled notice. Same
  capability-probe pattern as A2. Verified: `/actions` logs **zero** console errors when
  disabled. With A2 + A4 the DoD clause **"no uncaught console errors on any route"** is
  met. Unit web 1060 / server 595, e2e 91, CI green. **P0 (real data & honest behavior)
  is fully done: A1 ✓ A2 ✓ A3 ✓ A4 ✓.** Next: **P1 — B1** (Docker image + compose).

- **2026-09-19** — **B1 done** (PR #5, squash `0666a31`) — **first P1 item**. Multi-stage
  `Dockerfile`: `node:22-alpine` + pnpm builds the web bundle (`vite` → `apps/web/dist`); a
  pinned `oven/bun:1.3.9-alpine` runtime serves `dist` + `/api` from one Bun process (server &
  `@deck/schema` run from TS source — nothing to compile for them), with a `HEALTHCHECK` on
  `/api/health`. `docker/entrypoint.sh` supplies container `DECK_*` defaults (`DECK_CONFIG_DIR=/config`,
  `DECK_WEB_DIST`, `DECK_PORT=8080`) with every other `DECK_*` env passing through, and
  materializes a now-relative snapshot from a mounted estate's `snapshot.template.json` when
  `DECK_SNAPSHOT_SOURCE` is unset. `examples/compose.yaml` builds from repo root, mounts
  `examples/estate`→`/config` (ro), maps 8080. **Decision:** carry the whole built workspace
  into the runtime stage (same `/app` path) so pnpm's symlink store resolves under Bun — favors
  correctness over a minimal image (leaner pruning is a later optimization, not an acceptance
  criterion). `make-example-snapshot.mjs` gained optional `--template`/`--out` args (default
  no-arg behavior unchanged). Verified: `docker build` + `docker run` against `examples/estate`
  serves the app + API (portal renders, **zero console errors**), Docker healthcheck **healthy**;
  unit web 1060 / server 595, CI green. Next up: **B2** (`docs/deploying.md`).

- **2026-09-20** — **B2 done** (PR #6, squash `846f966`). `docs/deploying.md` — a
  self-contained operator guide built on B1's container: Docker + Compose run recipes
  (estate mounted at `/config`), a full environment-variable reference (core:
  `DECK_CONFIG_DIR`/`DECK_PORT`/`DECK_WEB_DIST`/`DECK_SNAPSHOT_SOURCE`/`DECK_LOG_LEVEL`;
  git sources: `DECK_SOURCES_CACHE_DIR`; integration credentials via the estate's
  `credentialEnv`; governed actions: `DECK_ACTIONS_ENABLED` + `DECK_DATA_DIR`/
  `DECK_RUNNERS_FILE`/`DECK_ACTION_TIMEOUT_MS`), ports/volumes, the snapshot refresh
  story (file vs `http(s)` URL, re-read each 60s poll — no restart), the `/api/health`
  body shape, and the reverse-proxy/TLS assumption (ties to E1). Linked from the README.
  Docs-only; every fact verified against the code (defaults, snapshot `path|url` +
  `pollIntervalMs: 60_000`, health shape, actions fail-fast, `deck validate` → clean).
  CI green. Next up: **B3** (`docs/configuring-your-estate.md`), the last P1 item.

- **2026-09-20** — **B3 done** (PR #7, squash `69ec848`) — **P1 COMPLETE (B1 ✓ B2 ✓ B3 ✓)**.
  `docs/configuring-your-estate.md` — a self-contained estate-authoring guide: the layered
  config-dir model (filename-sorted YAML layers, base vs overlay ownership, array-merge-by-
  identity with the identity keys), a field-level reference for every section (estate, hosts,
  services, groups, sources, integrations, actions incl. runner/confirm-modes/typed params),
  the secrets/`credentialEnv` posture, and validate/render CLI usage. Field names + enums
  verified against `packages/schema` (`deck.schema.json`, `ownership.ts`, `known-kinds.ts`,
  `merge.ts`) via a research subagent. Linked from README; cross-links deploying.md + arch
  docs. **Note:** `deck render <dir>` with no `--out` writes `deck.config.json` into cwd — a
  stray artifact to avoid committing (consider gitignoring it). Next up: **P2 — C1**
  (`sources[].credentialEnv` + private-repo auth; schema field already exists, thread it
  through the git spawner — candidate forge feature) and **C2** (snapshot ingestion story, doc-first).

- **2026-09-20** — **C1 done — verification-only (no PR); already shipped.** On picking up C1,
  found `Source.credentialEnv` and the full private-repo git-auth path were already implemented
  by the earlier `sources-docs-and-configs` forge feature — the item was written before that
  landed. Verified in the code: schema field `Source.credentialEnv` (pattern `^[A-Z][A-Z0-9_]*$`,
  `deck.schema.json` + `types.config.generated.ts:460`); `apps/server/src/sources/acquire.ts`
  reads the named env token and injects it as an ephemeral `http.extraheader` via `GIT_CONFIG_*`
  for the clone spawn only — never in the clone URL, argv, or on disk; and `sources-acquire.test.ts`
  asserts exactly those security properties (token absent from URL/argv/cache dir; no auth header
  when the env var is unset or the remote is non-HTTPS). Acceptance ("a private-repo source clones
  using a credential from `credentialEnv`; schema + validation + tests updated") is fully met. Next
  up: **C2** (snapshot ingestion story) — scope TBD with the user (doc-only vs. doc + helper script).

- **2026-09-20** — **C2 done** (PR #8, squash `98b60bb`) — **P2 COMPLETE (C1 ✓ verified, C2 ✓)**.
  `docs/producing-a-snapshot.md`, doc-only per plan + user confirmation. Documents the snapshot
  ingestion story: snapshots are produced by an external collector (Deck only reads via
  `DECK_SNAPSHOT_SOURCE`, file/URL, re-read each 60s poll); the full `SnapshotDocument` contract
  (required `schemaVersion`/`generatedAt`; ObservedHost coverage rules collected/partial/unreachable
  + collectors/containers/guests/managedConfigs/facts; ObservedService state enum; DriftFinding
  severity/location/waiver); freshness derivation (`collectedAt` vs `generatedAt`,
  `snapshotStaleAfter` default `PT24H`, fresh/stale/partial/never-collected); a minimal example
  (validated via `@deck/schema` `validateSnapshot` → classification 0) and an atomic-write +
  cron/CI refresh pattern. Cross-linked from deploying.md (replaced its C2 placeholder) + README.
  Next up: **P3** — D1 bundle code-split, D2 icon fallback, D3 visual polish (queued nit: desktop
  host/service detail declared-vs-observed cards stagger diagonally), D4 arch-docs backfill.

- **2026-09-20** — **D1 done** (PR #9, squash `f6bc9b7`) — first P3 item. **Root cause** of the
  1.27 MB chunk: `highlight.ts` imported the full `highlight.js` (~190 languages) while the feature
  only ever selects ~19 tokens from its `LANGUAGE_BY_*` tables. Switched to `highlight.js/lib/core`
  and register only those languages. **Bundle 1,274 kB → 392 kB (428 → 135 kB gz), a 69% cut** —
  under the 500 kB target with no route-splitting. Only behavior change: `hcl`/`.tf` (no core module)
  now falls back to escaped plaintext via the existing unknown-language path (never throws); every
  resolvable language unchanged. Verified: typecheck, 1060 web tests, and a browser check (Configs
  renders `smb.conf` highlighted as `ini`, zero console errors). Next up: **D2** (icon fallback).

- **2026-09-20** — **D2 done** (PR #10, squash `7e2cfa2`). Unknown/config-supplied `data-icon`
  names (a group's or link item's `icon:`) rendered as an invisible empty box. Added a neutral
  placeholder glyph via a base `[data-icon]::before { content: "▫" }`; mask icons suppress it
  (`::before { content: none }`) and known unicode glyphs override its content (later rules, equal
  specificity). CSS-only; covers every dynamic-name slot at once since `item.icon` flows straight to
  `data-icon`. Verified: build clean, 1060 web tests, browser check against an estate with unknown
  (`rocket`/`sparkles`) + known (`folder`) icons — unknowns show `▫`, folder shows its glyph, zero
  console errors. Next up: **D3** (visual polish, scoped tight per user: A3 findings + empty-state/
  spacing/focus-ring consistency, one PR, no redesign).

- **2026-09-20** — **D3 done** (PR #11, squash `b3b7bbb`) — scoped tight to the A3 finding per user.
  Fixed the declared-vs-observed diagonal stagger on host/service detail: `.intent-reality` is a 2-col
  grid whose `<h2>` took cell (r1,c1), pushing "Declared intent"→(r1,c2) and wrapping "Observed
  reality"→(r2,c1). Fix: `.intent-reality > h2 { grid-column: 1 / -1 }` so the heading spans both
  columns and the two sides sit side-by-side beneath it. Focus rings already covered by a global
  `:focus-visible` (left as-is). Verified: intent/reality share a row on desktop across Identity/Access/
  Backup, mobile still stacks, zero console errors; 1060 web tests. Only D4 (optional arch-docs) left in P3.

- **2026-09-20** — **E1 done** (PR #12, squash `0c9542d`) — first P4 item. **Decision: doc-only**
  (no built-in auth for v0.1.0; run behind an authenticating reverse proxy). `docs/security.md` makes
  the access model explicit and documents the boundaries deck holds against malicious estate/source
  input: actions safe-by-default, secrets by env-var name only (git token via `GIT_CONFIG_*`
  extraheader, never URL/argv/disk), source path confinement, DOMPurify as the single markdown XSS
  boundary, verbatim config rendering (operator curates via include/exclude), plus operator
  responsibilities + private vuln-reporting. Linked from README + deploying.md §8. All claims verified
  in code. Next up: **E2** (error handling & observability). *An E2 read-only audit already ran and
  found: HIGH — no shell-level web error boundary (a render throw blanks the app; PortalPage `/` is
  unprotected); MED — boot register/start not wrapped so an unexpected boot error is an unhandled
  rejection not classified exit(2); MED — Docker/Gatus report upstream HTTP failures as health `ok`;
  LOW — failed polls log at info not warn; LOW — web fetch helpers swallow with no console breadcrumb.*

- **2026-09-20** — **E2 done** (PR #13, squash `3f8ed4c`). Ran a read-only audit (subagent), then
  fixed all 5 findings: **HIGH** shell-level `ErrorBoundary` (App.tsx) so a render throw in any page
  (incl. `/` PortalPage) degrades to a retryable fallback with header/nav intact + resets on route
  change (+3 unit tests); **MED** wrapped `registerAllProviders`/`startScheduler` + top-level
  `boot().catch` → classified non-zero exit not unhandled rejection; **MED** docker/gatus report a
  non-2xx upstream as health `ok:false` (`HTTP <status>`) instead of empty-but-healthy; **LOW** failed
  polls log at `warn`; **LOW** web fetch helpers add `console.warn` breadcrumbs. Metrics: only
  `/api/health` (no `/metrics`) — adequate for v0.1.0, not built. Verified: typecheck, server 595 + web
  1063 tests, browser sweep of all 11 routes (shell intact, zero console errors). Next up: **E3** (CI
  e2e time). **E3 plan:** e2e is `workers:1, fullyParallel:false` (shared runtime dir + single Bun API),
  so shard across runners (`--shard=i/N`, own webServer each) + cache the Playwright browser; move e2e
  out of `node-pnpm` (keeps typecheck+unit, ~3min) into a matrix `web-e2e` job → ~5min critical path.

- **2026-09-20** — **E3 done** (PR #14, squash `cbf2168`). Sharded the Playwright e2e. `node-pnpm`
  now runs typecheck + unit only (**88s**); new `web-e2e` 2-shard matrix (own webServer per shard) +
  `~/.cache/ms-playwright` cache. Playwright shards by whole file; inventory.spec (42/91) is the atomic
  floor, so 2 shards ≈ optimal. **Measured critical path ~5.8min (web-e2e 2/2) vs ~11min — ~halved,
  same coverage.** Also updated the CI-structure meta-tests (drift-meta/inventory-meta) that asserted
  the old `pnpm -r test` shape. *Process note: `gh pr checks | tail -6` truncated the check list and
  nearly hid these meta-test failures — check the FULL list before merging. (Main was never at risk;
  the failures only appear when ci.yml changes, and CI caught them pre-merge.)* Next: **E4 — cut
  v0.1.0** (HELD for user go-ahead — the release milestone).

- **2026-09-20** — **E4 done — v0.1.0 SHIPPED 🎉** (PR #15, squash `936e19d`). **P4 COMPLETE; the
  entire v0.1.0 release plan is done.** Added `CHANGELOG.md` (Keep-a-Changelog) + root `version:0.1.0`
  (the 3 workspace packages were already 0.1.0). After merge: signed tag `v0.1.0` on `936e19d` (pushed)
  and a GitHub Release created from the changelog
  (https://github.com/garygentry/deck/releases/tag/v0.1.0). Definition of Done verified in full:
  documented container/deploy path, meaningful data on every surface, zero uncaught console errors,
  deploy + estate-config guides, CI green. **Release sequence this run (all squash-merged to main,
  each CI-green): B1 #5 · B2 #6 · B3 #7 · (C1 verified already-shipped) · C2 #8 · D1 #9 · D2 #10 ·
  D3 #11 · (D4 skipped, optional) · E1 #12 · E2 #13 · E3 #14 · E4 #15 → v0.1.0.**

<!-- Add entries as: **YYYY-MM-DD** — <item id> <what/decision/commit-or-PR>. -->
