# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.2] - 2026-09-25

The first published image with the 0.3.1 fixes: the 0.3.1 release build crashed under QEMU,
so no `0.3.1` image exists. Use this version.

### Fixed

- **Release image build:** the builder stage (`pnpm install` and the web build) now runs on the
  build machine's own platform for every target architecture. Building the arm64 image no longer
  runs any step under QEMU emulation, where `pnpm install` had crashed with "Illegal
  instruction" and stalled the release for 6 hours. The runtime image contents are unchanged: the
  server runs from TypeScript source under Bun, and its dependencies are pure JavaScript.

## [0.3.1] - 2026-09-25 [YANKED]

Not published as an image (see 0.3.2).

### Fixed

- **LLM usage transcript scan** (#35): the scan is now incremental. Each pass reads only the
  bytes appended since the last one, and its cache age counts from when a pass finishes.
  Previously, a slow first pass over a large history (about 3 minutes for 1.9 GB) was already
  stale when it finished, so any open deck page re-read the whole history in a loop.
- **LLM usage transcript totals** are no longer inflated about 2×. Claude Code logs one line per
  content block with the same usage, so responses are now counted once, by `message.id` and
  `requestId`.

## [0.3.0] - 2026-09-25

Two headline changes. First, the web UI overhaul (#29): `apps/web` is rebuilt on React 19,
Tailwind v4 and shadcn/Radix around a shared `@/ui` component library. Second, LLM usage (#33):
Claude Code and Codex plan limits. Apart from these, behaviour matches 0.2.0 except as noted
below.

### Added

- **LLM usage** (`llmUsage` config section): Claude Code and Codex plan limits on a new
  `/usage` page, a health-header pill and portal tiles. Sources are the Claude statusLine push
  (`POST /api/llm-usage/ingest`, bearer token, `scripts/statusline-ingest.sh`), the Claude OAuth
  usage endpoint, local Claude transcripts, and the Codex app-server, rollout files and usage
  history. Upstream polling adapts to activity, never polls the OAuth endpoint more than once
  every 2 minutes, and pauses when nobody is viewing. The image ships no Claude or Codex
  software: deck reads the Claude credentials from a read-only mount and runs the host's own
  `codex` binary (mounted). `deck validate` reports invalid `llmUsage` values (`LLM_USAGE_INVALID`).
  See `docs/guides/llm-usage.md`.
- `Meter` pattern in `@/ui`, and a `portal-summary` card slot on the portal page.

### Changed

- **UI stack**: Preact and the hand-written CSS layer are replaced by React 19, Tailwind v4
  theme tokens (light and dark, WCAG AA contrast-checked), Lucide icons and self-hosted Geist
  fonts. See `docs/architecture/ui.md` and ADR-004.
- **App shell**: a grouped sidebar (a sheet on mobile), a top bar with health pills, a
  system/light/dark theme menu, and a skip link.
- **Pages**: every feature is built from the `@/ui` library. Lists use popover facet filters;
  Monitoring gains a page heading and marks suppressed alerts with a badge; Actions audit detail
  opens inline; the Docs/Configs source switcher is a radiogroup.
- Routes load lazily (main chunk 295 → 161 KB gzipped).

### Fixed

- Enter on Cancel in a governed action's confirm step no longer runs the armed action. Enter
  on "Arm run" and on the audit detail's Close button now activates them.
- A page whose code chunk is stale after an upgrade reloads once instead of staying broken.

## [0.2.0] - 2026-09-22

Estate deployment & integration hardening (epic #26) — the friction and polish surfaced by deck's
first real deployment onto a live estate. Every change keeps deck a generic engine; the
reverse-proxy and operator-provided-snapshot posture is unchanged.

### Added

- **Published container image** — each `v*` tag builds a multi-arch (`linux/amd64` +
  `linux/arm64`) image and pushes it to `ghcr.io/garygentry/deck:<version>` (and `:latest`), so
  an estate pins a released image instead of building from source on a host (#16).
- **Production compose template** — `deploy/compose.prod.yaml` pulls the published image with
  named volumes, governed-actions vars commented out, `restart: unless-stopped`, and a
  loopback-bound port (front it with an authenticating proxy) (#17).
- **`deck snapshot validate <file>`** — a language-agnostic contract self-test for estate
  collectors, sharing the `0` clean / `1` findings / `2` tool-error exit scheme with
  `deck validate` (#18).
- **Prometheus `/metrics`** — an opt-in endpoint (`DECK_METRICS_ENABLED`) exposing per-provider
  poll success/failure and last-poll latency, snapshot age, and provider count; hand-rendered
  exposition, no new dependency (#19).
- **Host lifecycle status** — an optional `Host.status` (`active` / `planned` / `retired`) with a
  rendered badge at parity with service status; `hidden` stays orthogonal (#21).

### Fixed

- Overlay-layer reference validation now resolves against the merged document, so an overlay can
  reference a base-declared host without re-declaring stub hosts to satisfy a per-layer
  `REF_HOST_UNRESOLVED` check (#25).

## [0.1.0] - 2026-09-20

First public release. Deck is a generic, config-driven hub for a home-lab estate: a launch
portal, inventory beside observed reality (drift), a monitoring overview, and browsable
docs/configs — driven entirely by an estate config you author.

### Added

- **Launch portal & service status** — grouped portal (`groups`) with service cards and links,
  live binding/status where integrations are configured.
- **Inventory beside reality** — Hosts and Services surfaces render declared config next to an
  observed snapshot, with per-host freshness (fresh / stale / partial / never-collected).
- **Drift & coverage** — drift findings with severity, location, evidence, and waivers.
- **Monitoring overview** — Prometheus / Alertmanager / Gatus / Docker integrations surface
  alerts, metrics, and endpoint status.
- **Docs & Configs** — browsable markdown (sanitized) and verbatim config files from local or
  git-backed sources, with server-side search and path confinement.
- **Governed actions** — an opt-in, safe-by-default action surface (disabled unless enabled
  with a runner allowlist); runners are named, never shell commands, with an audit log.
- **Deployment** — a multi-stage `Dockerfile` (Bun runtime serving the built web + `/api`) and
  an `examples/compose.yaml`; a documented `docker build`/`run` path against `examples/estate`.
- **Example estate** — `examples/estate/` populates every surface out of the box (5 hosts,
  6 services, a now-relative snapshot, local docs/configs sources).
- **Documentation** — deploying, estate-config authoring, snapshot production, and a security &
  access posture guide, plus architecture docs for the core subsystems.
- **Theming & UI** — light/dark/system theme toggle, a decorative icon system with a neutral
  fallback for unknown names, and responsive layouts.
- **Health endpoint** — `GET /api/health` reports server + per-provider health.
- **CLI** — `deck validate` / `deck render` for estate configs.

### Changed

- Web bundle cut ~69% (1,274 kB → 392 kB) by using the highlight.js core build with only the
  languages the app selects.
- CI e2e wall time roughly halved by sharding the Playwright suite across runners and caching
  the browser.

### Fixed

- Provider polling is gated on a `/api/providers` discovery index — no more 404 console noise
  for unconfigured providers.
- The Actions surface probes an `/api/actions` capability endpoint instead of logging a 403
  when actions are disabled.
- A shell-level error boundary keeps a page render failure from blanking the whole app.
- Docker/Gatus integrations report an unreachable upstream as unhealthy rather than
  empty-but-healthy.
- Host/service detail sections align declared intent beside observed reality (no diagonal
  stagger).

### Security

- No built-in auth: Deck is intended to run behind an authenticating reverse proxy (see
  `docs/security.md`).
- Credentials are referenced by environment-variable name only; git source tokens are injected
  via ephemeral `GIT_CONFIG_*` headers, never the clone URL, argv, or on-disk config.
- Source file access is confined to the source root (rejects `..`, absolute paths, NUL bytes,
  and symlink escapes); rendered markdown passes a single DOMPurify sanitize boundary.

[Unreleased]: https://github.com/garygentry/deck/compare/v0.3.2...HEAD
[0.3.2]: https://github.com/garygentry/deck/releases/tag/v0.3.2
[0.3.1]: https://github.com/garygentry/deck/releases/tag/v0.3.1
[0.3.0]: https://github.com/garygentry/deck/releases/tag/v0.3.0
[0.2.0]: https://github.com/garygentry/deck/releases/tag/v0.2.0
[0.1.0]: https://github.com/garygentry/deck/releases/tag/v0.1.0
