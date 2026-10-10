# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

The extensibility work: deck becomes a small kernel plus modules on one public contract, the UI
becomes a config-driven tree of extensions, and there are supported ways to add what deck does
not ship. It is drafted as two releases:

- **0.4.0** (breaking): the module contract, schemaVersion 2 with `deck config migrate`,
  config-driven UI, dashboards and widgets (#15–#30, #40, #41, #43, #44). It is the history up
  to the merge of #44.
- **0.5.0**: the external extension tiers (sidecars, runtime modules, the module template), the
  browser security pass, and the move of the built-in modules into `modules/<id>/` (#39,
  #45–#49, #55–#73, #76).

Whether these ship as two tags or as one release is the maintainer's call. For one release,
merge the two sections, including both Migration sections: the framing changes in 0.5.0's
Migration are breaking too.

### 0.4.0

The configuration format changes: deck accepts only `schemaVersion: 2`. Run
`deck config migrate` on your config directory before upgrading (see Migration below). The HTTP
API paths of 0.3.2 keep working; `/api/config` returns the config in its new shape.

#### Added

- **Modules.** Every feature is now a module on one contract (`@deck/module-sdk`): it declares
  its config section, provider kinds, routes, health, findings and UI contributions in a
  manifest, and the kernel names no feature. Each module's routes are served under
  `/api/m/<id>`, with the 0.3.2 paths (`/api/actions`, `/api/sources`, `/api/llm-usage`) kept as
  aliases with identical responses. `/api/health` gains `modules`, every module's state by id;
  its other fields are unchanged.
- **`deck config migrate <dir> [--dry-run]`** rewrites a schemaVersion 1 config directory as
  version 2, layer by layer and in place. It keeps comments, formatting and line endings,
  migrates a symlinked layer at its target, writes nothing unless every layer migrates, and is a
  no-op on a directory that is already current. `--dry-run` prints a unified diff per layer and
  writes nothing.
- **`deck validate --advisory-disabled`** reports problems in a switched-off module's section as
  info `MODULE_SECTION_DISABLED` instead of at their real severity.
- **`GET /api/ui`**, the resolved UI manifest the web shell renders from: brand, home page,
  modules, nav groups and entries, pages, slots, extensions, providers and widget types. It is
  sent with an `ETag`, and its `findings` report problems that never stop the UI from rendering
  (`UI_UNKNOWN_EXTENSION`, `UI_UNKNOWN_SLOT`, `UI_HOME_UNKNOWN` and others).
- **The `ui` config section** (overlay layer only). See the `ui` section of
  `docs/reference/estate-config.md`.
  - `ui.brand`: `title`, `icon` and `logoUrl` for the sidebar, the browser tab and the page
    title. Without it the title is `estate.name` (#25).
  - `ui.theme`: the operator's default `mode`; four presets beyond `teal` (`slate`, `copper`,
    `rose`, `high-contrast`), contrast-tested in light and dark; `density` (`compact`,
    `comfortable`); and `radius` (`none`, `sm`, `md`, `lg`). A viewer's own light/dark choice
    still wins (#25, #26).
  - `ui.home`: any page id can be the page `/` renders. The default is still the portal (#25).
  - `ui.nav`: group order, labels and icons, config-defined groups, and external links and
    separators (#27).
  - `ui.extensions`: switch off, move or re-order any extension, page, nav entry or widget by
    id (#27).
- **`ui` hot reload.** deck watches its config directory. An edit confined to `ui` applies
  without a restart; an invalid edit keeps the last good config and shows `UI_CONFIG_INVALID` in
  the shell; an edit outside `ui` is reported as `UI_RESTART_REQUIRED` (#28).
- **Dashboards without code** (`ui.pages`): pages of sections (1–4 columns) of widgets, each
  reading a provider, with an optional server-side JMESPath `select`. Widget options are
  validated with the config, so a bad option stops boot at its path (#30). See
  `docs/guides/build-a-dashboard.md` and `examples/dashboard/`.
- **Widget types:** `core/stat`, `core/stat-grid`, `core/meter`, `core/key-value`, `core/list`,
  `core/table`, `core/status-grid`, `core/link-tiles`, `core/markdown`, `core/health-pills` and
  `core/json` (#30, #41), plus `portal/groups`, the portal's groups and filters as a widget (#43).
  See `docs/reference/widget-types.md`.
- **`ui.statusMaps`**: named value maps and numeric threshold rules that turn widget values into
  status tones (#41).
- **`core/embed`** shows another site's page in a sandboxed frame. It needs
  `ui.allowUnsafeEmbeds: true`; without it the widget frames nothing and says embeds are off,
  and `deck validate` notes `UI_EMBED_DISALLOWED` (info). The gate takes effect on hot reload
  (#44).
- **`http-json` data source**: an integration that polls any HTTP API answering JSON, with the
  credential read only from the environment variable `credentialEnv` names, a size cap, and
  classified failures. An authenticated request never leaves its configured origin: a
  cross-origin redirect fails the poll (#29).
- **Snapshot content-age metrics** on `/metrics`: `deck_snapshot_generated_age_seconds` and
  `deck_snapshot_generated_timestamp_seconds`, from the snapshot's `generatedAt` (#24).

#### Changed

- **The portal is a dashboard.** Its page is `page:portal/overview` at `/portal`, and `/` still
  renders it while it is the home page. Card status now works for any status-capable binding:
  `http-health` bindings drive live portal cards, as `docker` and `gatus` ones do (#43).
- **Navigation follows the modules that run.** Pages of a switched-off module are not listed or
  routed; opening one directly shows "module not enabled", naming the setting that turns it on
  (for example `DECK_ACTIONS_ENABLED=true`) (#15).
- **`GET /api/config`** returns the merged config in the schemaVersion 2 shape: `groups`,
  `actions` and `llmUsage` are under `modules.portal.groups`, `modules.actions.actions` and
  `modules.llm-usage`, and `agents` is gone. A script that reads those keys needs the new paths.
- **`deck validate`** notes a section of a module that is switched off where it runs with an info
  `MODULE_SECTION_DISABLED`; `--advisory-disabled` turns that section's own problems into info as
  well. A binding or integration of a provider kind whose
  module is off is `PROVIDER_KIND_DISABLED`: a warning in `deck validate`, info at boot. A
  binding of a kind that takes none (`prometheus`,
  `alertmanager`, `snapshot`, `http-json`) is reported as `PROVIDER_BINDING_UNSUPPORTED` (info)
  instead of being ignored silently. A `modules.<id>` section for a module deck does not have is
  `MODULE_UNKNOWN`.
- **Runtime image:** Bun 1.4.2 (was 1.3.9), pinned in `.bun-version` for the image and CI
  (#40).

#### Migration

1. **Migrate the config to schemaVersion 2.** deck 0.4.0 refuses a version 1 config with
   `CONFIG_MIGRATION_REQUIRED` (exit 2), at boot and in `deck validate`. Preview, apply, then
   validate:

   ```sh
   deck config migrate <config dir> --dry-run
   deck config migrate <config dir>
   deck validate <config dir>
   ```

   From a checkout, `deck` is `bun apps/server/src/cli/deck.ts`; for an image deployment see the
   upgrade checklist below. The keys move as follows:
   `groups` → `modules.portal.groups`, `actions` → `modules.actions.actions`, `llmUsage` →
   `modules.llm-usage`, `agents` is removed (it was reserved and unused; a warning is printed if
   it had entries), and `schemaVersion` becomes `2`. Snapshots are unaffected and stay at their
   own `schemaVersion: 1`. `GET /api/config` returns the new shape too.
2. **Give every provider its own id.** Integration, source and binding ids share one provider-id
   space, and an id used in two of them, or by two bindings, is the new `PROVIDER_ID_SHARED`
   warning. Rename one and update what refers to it. (0.5.0's `PROVIDER_ID_RESERVED` is a
   different check: an id taken from a kind's fixed provider id.)
3. **Move credentials out of deck's own variables.** A `credentialEnv` that names a deck
   deployment setting (`DECK_CONFIG_DIR`, `DECK_DATA_DIR`, `DECK_PORT` and the like) or a variable
   another module owns (`DECK_SNAPSHOT_SOURCE`) is refused: deck does not read it, so the
   credential is not sent, and `deck validate` reports `MODULE_CREDENTIAL_ENV_REFUSED` (warning).
   Put the secret in a variable of its own and name that.

   Like every warning, both fail `deck validate` (exit 1). Boot logs them and carries on, unless
   two declarations sharing an id both register a provider (`PROVIDER_DUPLICATE_ID`).
4. **`DECK_DATA_DIR` must be an absolute path.** With governed actions on, a relative path now
   fails boot. The audit store stays at `$DECK_DATA_DIR/actions`, so existing history is kept.
5. **Image:** the runtime is Bun 1.4.2. Nothing to change unless you run deck from source on an
   older Bun.

No finding code or `DECK_*` environment variable of 0.3.2 is removed or renamed, and the HTTP
API paths are unchanged (the `/api/config` body is the new shape).

**Upgrade checklist for an image deployment.** 0.3.2 cannot boot a schemaVersion 2 config, and
0.4.0 cannot boot a version 1 config, so migrate and re-pin together. The 0.4.0 image carries the
CLI at `/app/apps/server/src/cli/deck.ts`; run it with the config directory mounted **writable**
(the deployment mounts it read-only):

```sh
cp -a /path/to/your/estate /path/to/your/estate.v1-backup     # 1. back up every layer
deck_cli() { docker run --rm -v /path/to/your/estate:/config --entrypoint bun \
  ghcr.io/garygentry/deck:0.4.0 /app/apps/server/src/cli/deck.ts "$@"; }
deck_cli config migrate /config --dry-run                     # 2. review the diff
deck_cli config migrate /config                               # 3. apply
deck_cli validate /config                                     # 4. expect exit 0
```

Give `deck_cli validate` the same `-e` settings as the deployment (`DECK_SNAPSHOT_SOURCE`, say),
since some checks read them. Then re-pin the deployment to `0.4.0` straight away and check
`/api/health`. To roll back, restore the backup over the config directory and re-pin `0.3.2`.

### 0.5.0

Graded ways to extend deck beyond config: a sidecar in any language, a runtime module dropped
into a directory, and a template to start one from. Browsers now get an enforced
Content-Security-Policy, and framing deck from another origin is refused unless configured (see
Migration below).

#### Added

- **Remote sidecars** (`remote` integration kind, protocol v1): deck polls
  `<url>/deck/v1/data` and asks `<url>/deck/v1/describe` for the declarative widgets, links and
  nav the sidecar contributes, validated against the same widget schemas and shown on the
  sidecar's own page. Each sidecar has its own health entry. See
  `docs/reference/remote-provider-protocol.md`, `docs/guides/write-a-sidecar-module.md` and the
  NUT UPS example in `examples/sidecars/nut-ups/` (#45, #46).
- **Runtime modules** (`DECK_MODULES_DIR`): a directory of modules, each with a
  `deck-module.json`, loaded under the same lifecycle as the built-ins. Off unless
  `DECK_MODULES_ENABLED=true`; while it is off deck reads their manifests and imports no code. A
  module that fails to load is disabled with `MODULE_LOAD_FAILED` and boot continues, unless its
  config section is present and invalid (#39).
- **Integrity pins** (`moduleIntegrity.<id>`) and **`deck module digest <dir>`**, which prints
  the `sha256-…` pin of a module directory. A module that does not match its pin is not
  imported (#39).
- **Web halves of runtime modules**, served at `/modules/<id>/web.js` and `web.css` and loaded
  through an import map. They build against **`@deck/sdk`**, the curated `@/ui` patterns,
  `Icon` (including module-contributed SVG icons), tones and data hooks. An incompatible or
  failing module shows a tile instead of breaking the page (#47).
- **Module template** in `examples/modules/hello/`, with a Vite library build, the
  `@deck/sdk/tailwind` preset, and **`deck-module lint`**, which checks a module against deck's
  UI rules (#49). See `docs/guides/runtime-modules.md` and `docs/guides/write-a-module.md`.
- **`ui.frameAncestors`** and **`ui.frameSources`** (see Migration) (#48).
- Architecture decisions ADR-005 (module contract and kernel), ADR-006 (config-driven UI) and
  ADR-007 (extension tiers and trust), the explanation "Kernel and modules", and references for
  the module manifest and widget types (#56).

#### Changed

- **Browser security policy** (#48): the web shell is served with an enforced
  Content-Security-Policy (scripts from deck's origin with a per-response nonce, `fetch` to deck
  only, frames limited to the `core/embed` origins in the config), and every response carries
  `frame-ancestors` and `X-Content-Type-Options: nosniff`, plus `X-Frame-Options: SAMEORIGIN`
  unless `ui.frameAncestors` lists other origins. `docs/security.md` gains the trust model for
  each extension tier.
- **Reserved provider ids:** an integration, source or binding that takes a fixed provider id
  registered by another kind (`prometheus` beside a `prometheus` integration, or `snapshot` while
  `DECK_SNAPSHOT_SOURCE` is set) is reported by `deck validate` as `PROVIDER_ID_RESERVED`
  (error), since boot would fail on it with `PROVIDER_DUPLICATE_ID` (#48).
- A built-in module whose manifest or schema is unusable now stops boot
  (`MODULE_MANIFEST_INVALID`) instead of being switched off silently (#48).
- A `remote` sidecar can no longer redirect deck to another origin (#48).
- **Sources are stricter about what they serve** (#76):
  - `include` and `exclude` now apply to every read (file, raw, search and the tree), not only
    the tree listing. An excluded path answers 404 `PATH_NOT_FOUND`, like a missing file.
  - They match a symlink's real target as well as its own path, so a symlink to a file that is
    not included, or is excluded, is neither listed nor served.
  - `exclude` matches regardless of case: `build/**` also hides `Build/`.
  - `/api/sources/<id>/raw` serves only files in the tree, or images under an `include` glob's
    base. The file name, the real path and the file's bytes must agree on the image type. Raw
    responses carry `Content-Security-Policy: sandbox; default-src 'none'` (plus inline styles)
    and `nosniff`, so a script in an SVG opened by its raw URL does not run.
- Every built-in module now lives in its own `modules/<id>/` workspace package, with its schema,
  server half, web half and tests. Behaviour is unchanged (#55, #57, #58, #59, #63, #64, #65,
  #66, #68, #69, #71, #73).

#### Migration

1. **Framing deck from another origin is refused by default.** A page on another origin that
   shows deck in a frame (a Home Assistant panel, say) stops showing it. List that origin in the
   overlay layer:

   ```yaml
   ui:
     frameAncestors: [https://ha.example.net]
   ```

2. **Embeds that redirect to another origin need `ui.frameSources`.** With
   `ui.allowUnsafeEmbeds`, a framed page may load only from its embed URL's own origin. One that
   redirects elsewhere (single sign-on or forward-auth such as Authelia or Authentik, or an
   `http`→`https` redirect that also changes the port) needs that origin listed. A plain upgrade
   to `https` on the default port needs nothing.

   ```yaml
   ui:
     frameSources: [https://auth.example.net]
   ```

3. **Injected inline and cross-origin scripts no longer run.** The shell's
   Content-Security-Policy allows scripts from deck's origin and inline scripts carrying the
   response's nonce. An inline script a reverse proxy injects into deck's HTML (it has no nonce),
   or a script from another origin, is refused. A script tag pointing at a path on deck's own
   origin still runs.
4. **Some embed URLs cannot be framed.** While embeds are on, an embed URL whose origin the
   Content-Security-Policy cannot name (an IPv6 literal, or a hostname with `_`) is
   `UI_EMBED_NOT_FRAMEABLE` (warning), and the widget says it can't be embedded. `frameSources`
   does not help: give the service a DNS-style hostname, or link to it instead.
5. **Sources: symlinks, excludes and raw files.** A repository that symlinks a file from outside
   its `include` globs into an included directory, or that relied on `exclude` being
   case-sensitive, loses those files: the symlinked ones are no longer listed or served, and a
   differently-cased path that an `exclude` matches is now hidden. Copy the file into an included
   path, widen `include`, or narrow the `exclude` glob. `/raw` likewise no longer serves a file
   that is outside the tree and not an image under an `include` glob's base, nor an image whose
   name and bytes disagree on its type (a `.png` that is really a JPEG, say): rename or re-save
   it.

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
