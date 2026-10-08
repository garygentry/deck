# HTTP API reference

This is deck's internal HTTP surface, consumed by the bundled web app.
It is not a committed public API: routes, response shapes, and error codes are subject to change
between versions, and deck ships no authentication of its own.
Access control is the job of the authenticating reverse proxy an operator places in front of
deck, so this surface is proxy-fronted rather than directly exposed.

All routes are served under `/api` by the single Bun process.
Response bodies are JSON unless noted.
Response type names below refer to the `@deck/server` contract barrel
(`apps/server/src/contract/index.ts`); the estate config document returned by `/api/config`
follows the estate config schema.

## Config, providers, health

| Method | Path | Purpose | Response |
| --- | --- | --- | --- |
| `GET` | `/api/config` | The loaded, merged estate config document. | `DeckConfig` |
| `GET` | `/api/providers` | Registered providers' identities (id and kind), in deterministic id order. | `ProvidersResponse` |
| `GET` | `/api/providers/:id` | One provider's cached envelope (data, freshness, error). Unknown id → 404 `PROVIDER_NOT_FOUND`. | `ProviderEnvelope` |
| `GET` | `/api/health` | Cached readiness: overall status, uptime, provider count, and per-provider health. Performs no upstream I/O. | `HealthResponse` |
| `GET` | `/api/ui` | The resolved UI manifest: brand, home page, modules, slots, pages, nav groups and entries, extensions and providers. Resolved once at startup. | `UiManifest` (`@deck/module-sdk`) |

`HealthResponse.status` is `degraded` when any provider's latest health is not ok, otherwise `ok`.
`HealthResponse.modules` lists every known module's state by id. A module with no health report
of its own (`portal`, `inventory`, `drift`, `monitoring`) shows `{state: "ok"}` while it runs.

### UI manifest

`/api/ui` tells the web shell what to render, where, and with what config. It is built at startup
from every module's declared contributions. The portal, inventory, drift, monitoring, actions and
llm-usage features are built-in modules (`origin: "module"`), as is `metrics`, which contributes
no UI. Features not yet on the module contract declare theirs from the kernel and are listed with
`origin: "kernel"`.

- `modules` lists every known module with `enabled` and, when not enabled, a `reason`. A
  module that is disabled (its enabling section or env var is absent, its manifest is unusable,
  or a kernel capability such as actions is off) contributes nothing. When the module is off
  only because settings that enable it are unset, `enabledBy` lists them: its own (for example
  `[{"env": "DECK_ACTIONS_ENABLED"}]`, or `{"config": "modules.<id>"}`), then those of a
  `dependsOn` dependency that is off only because of its own. It holds names only, never a
  value, and is absent rather than empty.
- `disabledPages` lists the pages of disabled modules (`id`, `module`, `path`, `title`, `icon`),
  so the shell can answer their paths with "module not enabled". A page whose path an enabled
  page or a root path serves is left out, and so is one whose path is not a usable page path
  (with a `UI_INVALID_PAGE` finding).
- `pages`, `nav` and `extensions` hold only what renders. Extension ids have the form
  `<kind>:<module>/<name>` (for example `pill:llm-usage/summary`). Each extension and nav entry
  names the slot it attaches to and its order there, and attaches only to a slot that accepts
  its kind.
- `brand.title` is the name the shell shows in the sidebar and the document title:
  `ui.brand.title`, else the estate's `estate.name`, else `Deck`. `brand.icon` and
  `brand.logoUrl` are present when `ui.brand` sets them.
- `home` names the page `/` renders (`page`) and that page's own path (`path`): `ui.home` when
  it names a routed page without path parameters, else the portal. It is absent when neither
  can be home, and then `/` is not found. No page is routed at `/` itself: `/` always renders
  the home page.
- `navGroups` lists the sidebar's groups in order, each with its `label`. The built-in order is
  Overview, Inventory, Health, Operate, Knowledge; a group a module uses that is not among them
  follows, by id, headed by its id. Only groups with a nav entry are listed.
- `nav` is sorted by group (in `navGroups` order), then order, then id: `order` applies within a
  group. Each entry has a `label` and, usually, an `icon`; an entry to a page that declares none
  of its own takes the page's title and icon.
- `providers` lists the registered provider instances (id and kind), so the web polls only
  providers that exist.
- `findings` holds problems that never stop the UI from rendering:
  - `UI_UNKNOWN_EXTENSION`: an override for an unknown id, or a nav entry to an undeclared page;
  - `UI_UNKNOWN_SLOT`: an extension on an unknown slot;
  - `UI_SLOT_KIND_MISMATCH`: an extension on a slot that does not accept its kind;
  - `UI_PAGE_PATH_COLLISION`: two pages on one path, a page on a module's declared root
    path, which the server always answers instead (or 404s while that module is off), or a page
    declaring `/`, which renders the home page;
  - `UI_HOME_UNKNOWN`, `UI_HOME_DISABLED`, `UI_HOME_NOT_ROUTABLE`: `ui.home` names an unknown
    page, a page that is not routed (its module is off, an override disables it, or its path is
    taken), or a page with path parameters; the portal stays home;
  - `UI_DUPLICATE_ID`: an id or slot contributed twice (the incumbent keeps it: the kernel's
    shell first, then the kernel-wired features and built-in modules, then other modules), or
    a nav group configured twice (its first entry is used);
  - `UI_INVALID_OVERRIDE`: a malformed override.
  - `UI_INVALID_PAGE`: a disabled module's page whose path is not a usable page path, so it is
    not listed in `disabledPages`.

  Overrides come from the `ui.extensions` config section (see the
  [estate configuration reference](estate-config.md#ui)).

### The web shell's page

When deck serves the web app, every path outside `/api` that is not a static file (including
`/` and `/index.html`) answers with the shell's `index.html`, sent with `Cache-Control: no-cache`.
The server writes two things into it: the brand title as its `<title>`, and a boot object in
`<script type="application/json" id="deck-boot">`, which the page reads before it can make any
request:

```json
{ "bootApi": 1, "brand": { "title": "Gentry Lab" }, "theme": { "mode": "dark" } }
```

`theme.mode` is `ui.theme.mode`, absent when unset; the pre-paint script applies it unless the
viewer has chosen a mode. The shape is `DeckBoot` in `@deck/contract`; a new boot-time setting is
an optional field there.

## Metrics

When `DECK_METRICS_ENABLED` is true, the built-in `metrics` module serves `GET /metrics` —
outside `/api` — as Prometheus text exposition (`Content-Type: text/plain; version=0.0.4`),
built from cached registry state with no upstream I/O. Any other method gets deck's plain 404.
When the flag is off the module does not run and `/metrics` answers the plain 404; it is
never rewritten to the web app, either way.
See [Connect monitoring](../guides/connect-monitoring.md#scrape-decks-own-metrics) for the
metric names.

## Sources

The four source-browsing routes are read-only (`GET`). When the id is not a declared source of a
kind a running data-source module serves, the route answers 404 `SOURCE_NOT_FOUND`.

These routes belong to the `sources` module. It serves them under `/api/m/sources` as well, and
keeps the `/api/sources` paths as aliases with identical responses. `/api/health` lists it under
`modules.sources`, and the `markdown-tree` and `file-tree` data sources under their own ids.

| Method | Path | Purpose | Response |
| --- | --- | --- | --- |
| `GET` | `/api/sources/:id/tree` | The source's file tree as a manifest of POSIX-relative paths. | `SourceManifest` |
| `GET` | `/api/sources/:id/file?path=<rel>` | One confined file's contents; `content` is omitted when truncated or binary. | `FileReadResult` |
| `GET` | `/api/sources/:id/raw?path=<rel>` | Raw image bytes for a markdown-relative image; non-image paths are refused. | image bytes (`Content-Type: image/*`, `X-Content-Type-Options: nosniff`) |
| `GET` | `/api/sources/:id/search?q=<q>` | Scoped, capped text search across the source. | `SourceSearchResult` |

A missing `path` on `/file` or `/raw`, or a missing/blank `q` on `/search`, is a 400.
A path that escapes the source root is refused as `PATH_NOT_CONFINED`; the attempted path is
never echoed in the response.

## Actions

The governed-actions routes are off by default and enabled only when the actions capability is
configured (see [Environment variables](./environment-variables.md)).
When the capability is off, the run, cancel, and audit routes refuse with 403 `ACTIONS_DISABLED`;
the probe route always answers 200 so the web can learn the capability state without provoking a
403.

These routes belong to the `actions` module. It serves them under `/api/m/actions` as well, and
keeps the `/api/actions` paths as aliases with identical responses, whether the capability is on or
off. `/api/health` lists the module under `modules.actions`: `{state: "ok"}` while it runs, else
`{state: "disabled", detail}`.

| Method | Path | Purpose | Response |
| --- | --- | --- | --- |
| `GET` | `/api/actions` | Capability probe; reports whether governed actions are enabled. Always 200. | `ActionsCapabilityResponse` |
| `POST` | `/api/actions/:id` | Run a declared action after the pre-run gates; streams run events. | NDJSON (`application/x-ndjson`) of `ActionRunEvent` |
| `POST` | `/api/actions/runs/:runId/cancel` | Cancel an in-flight run. Unknown run → 404 `RUN_NOT_FOUND`. | 202, empty body |
| `GET` | `/api/actions/audit` | Audit history, newest first. | `AuditListItem[]` |
| `GET` | `/api/actions/audit/:runId` | One audit entry with full output. Unknown id → 404 `AUDIT_NOT_FOUND`. | `AuditDetail` |

`POST /api/actions/:id` applies four pre-run gates in order, each with its own status and code:
capability (403 `ACTIONS_DISABLED`), declared id (404 `ACTION_UNKNOWN`), runner resolution
(422 `RUNNER_UNRESOLVED`), and parameter validation (400 `PARAMS_INVALID`).
A parameter-validation refusal additionally carries a `paramErrors` array alongside the error
envelope.

## LLM usage

Present when the estate config has a `modules.llm-usage` section; the read routes answer
`enabled: false` otherwise.
Every read counts as a viewer, which keeps upstream polling awake (see `idlePause`).

| Method | Path | Purpose | Response |
| --- | --- | --- | --- |
| `GET` | `/api/llm-usage` | Current usage bars, per-source states and poll state. Performs no upstream I/O. | `LlmUsageResponse` |
| `GET` | `/api/llm-usage/refresh` | The same after an immediate poll, debounced to once per 5 seconds. Codex is always re-read; the Claude OAuth endpoint only if its last call was 2+ minutes ago and deck is not backing off. | `LlmUsageResponse` |
| `POST` | `/api/llm-usage/ingest` | A Claude Code statusLine payload (JSON, at most 2 MB), with `Authorization: Bearer <token>`. Registered only when the env var named by `modules.llm-usage.claude.statusLine.credentialEnv` is set. | 204, empty body |

These routes belong to the `llm-usage` module. It serves them at `/api/m/llm-usage`,
`/api/m/llm-usage/refresh` and `/api/m/llm-usage/ingest` as well, and keeps the `/api/llm-usage`
paths as aliases with identical responses.

`/api/health` gains an `llmUsage` entry (`mode`, `lastPollAt`, `consecutiveErrors`) when the
feature is on, and always lists the module under `modules["llm-usage"]`: `{state, data}`, where
`data` is the same entry, or `{state: "ok", detail: "not configured"}` without the section.
Neither changes the overall health `status`.

## Errors

API errors share one envelope.

```json
{ "error": "human-readable message", "code": "MACHINE_CODE" }
```

`error` is always present; `code` is present for classified errors.

| Code | Status | Meaning |
| --- | --- | --- |
| `NOT_FOUND` | 404 | An `/api/*` path with no matching route. |
| `SHUTTING_DOWN` | 503 | The request arrived after deck began shutting down (on a kept-alive connection); the connection is closed. |
| `PROVIDER_NOT_FOUND` | 404 | No provider registered with the requested id. |
| `SOURCE_NOT_FOUND` | 404 | Sources capability off, or no source declared with the requested id. |
| `UNAUTHORIZED` | 401 | LLM usage ingest with a missing or wrong bearer token. |
| `PAYLOAD_TOO_LARGE` | 413 | LLM usage ingest body over 2 MB. |
| `BAD_JSON` | 400 | LLM usage ingest body is not JSON. |
| `INTERNAL` | 500 | Unhandled server error; the message is generic and details are logged, not returned. |

The source routes additionally use `PATH_NOT_FOUND` and `PATH_NOT_CONFINED` (both 400), and the
action routes use the capability, gate, and lookup codes listed under
[Actions](#actions).

## Related references

- [Environment variables](./environment-variables.md) — capability switches that gate these routes.
- [CLI reference](./cli.md) — offline config validation and rendering.
