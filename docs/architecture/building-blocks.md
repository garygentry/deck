# Building-block view: engine subsystems

## Purpose

This chapter maps the internal subsystems of the deck server and shows how a boot, a poll, and an
API request move through them.
It is the connecting spine for the architecture set: a few features carry their own detailed
building-block notes, and the rest are summarised here so the whole engine stays visible at one
altitude.

## Content

The server is a single Bun process whose subsystems are wired together once, at boot, and then
serve requests from cached state.
The subsystems below are listed in the order boot touches them.

### Config load, merge, and validate

Boot begins by loading estate configuration.
The loader resolves the config directory, reads every `*.yaml` layer in lexical order, and folds
the layers together: it validates the base layer, then for each overlay validates it against the
accumulated document and merges it, and finally validates the merged result.
Merging and the schema logic live in `@deck/schema` (`merge.ts` and `validate/**`); the
server-side orchestration lives in `apps/server/src/config/`.
The outcome is one of three exit classes — clean, findings, or tool error — and boot fails fast on
anything but clean, so the process never serves a document it could not validate.

### Boot wiring

With a trusted config in hand, `boot.ts` resolves the two optional capabilities (sources and
actions) from config and environment, registers providers, starts the poll scheduler, and builds
the Hono app with the config, provider reader, and capability bundles injected as dependencies.
A misconfiguration in any of these steps fails fast with a classified error and a non-zero exit
rather than a half-configured server.

### Provider registry and poll scheduler

Monitoring and inventory data is served through a provider registry
(`apps/server/src/providers/registry.ts`).
`registerAllProviders` translates estate declarations — integrations, host and service bindings,
the runtime snapshot source, and declared document sources — into providers of one of nine kinds:
`alertmanager`, `docker`, `file-tree`, `gatus`, `http-health`, `link`, `markdown-tree`,
`prometheus`, and `snapshot`.
The scheduler polls each dynamic provider on its own interval, caches the latest envelope with a
freshness state, and isolates failures so one failing provider never stops the others.
The `link` kind is static and is not polled.
API reads (`/api/providers`, `/api/providers/:id`, `/api/health`) return cached envelopes and
health without any upstream I/O.

### Drift projection

The snapshot provider's cached generation feeds drift derivation
(`apps/server/src/drift/**`).
`deriveDriftProjection` takes the observed snapshot and an explicit clock and produces an immutable
view: drift findings grouped by host then service, coverage rows per host, waiver state judged
against the clock, and summary counts.
Because the clock is an explicit input and host freshness is judged relative to it, the same
snapshot can read as fresh or stale depending on when it is derived.

### Sources runtime

The sources subsystem (`apps/server/src/sources/**`) browses declared document and config
repositories read-only, with path confinement, git acquisition, and an on-disk cache.
It is capability-gated: when no supported sources are configured the source routes do not serve,
and a store is built only for supported source kinds.

### Actions runtime

The actions subsystem (`apps/server/src/actions/**`) executes governed actions through an
allowlisted runner, with parameter validation, confirmation, an execution timeout, and an audit
store.
It is off by default: unless `DECK_ACTIONS_ENABLED` is set and the required data directory and
runner manifest are provided, the capability bundle is absent and every action route refuses with
403.

### The Hono app

All of the above is exposed through one Hono application (`apps/server/src/server/app.ts`).
It layers request logging, the config/provider/health GET routes, error and not-found boundaries,
then the source and action routes, and finally — when a built web bundle is present — the static
assets and SPA fallback.

### Request and poll flow

Two flows dominate.
A **poll** runs on a timer: the scheduler calls a provider's `fetch`, stores the resulting
envelope with a derived freshness state, and updates cached health.
A **request** is served from that cached state: an API read returns the cached envelope or derives
a fresh drift projection from the cached snapshot, without touching upstream systems on the request
path.

## Related decisions

- [ADR-001: Run the server and schema from TypeScript source under Bun](./decisions/adr-001-bun-from-source.md)
- [ADR-002: Layered estate config merged into one document](./decisions/adr-002-layered-config.md)
- [ADR-003: Separate declared intent from observed reality](./decisions/adr-003-intent-vs-reality.md)

Per-feature building-block notes exist for three shipped features and go deeper than this chapter:

- [Hosts and services](./hosts-and-services.md)
- [Governed actions](./governed-actions.md)
- [Sources, docs and configs](./sources-docs-and-configs.md)

Other features — drift and coverage, alerts and health, the portal, and the engine core — do not
have their own notes and are summarised in the subsystems above.

![Building-block view: the config loader feeds boot wiring, which registers providers and starts the poll scheduler feeding drift projection; the sources and actions runtimes are capability-gated, all exposed through the Hono app.](./diagrams/building-blocks.svg)

*Server building blocks: the config loader feeds boot wiring, which registers providers and starts
the poll scheduler that feeds drift projection; the sources and actions runtimes are each
capability-gated, and everything is exposed through the Hono app.*
