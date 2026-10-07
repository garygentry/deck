# deck — Estate Deployment & Integration Hardening Plan (post-v0.1.0)

**Goal:** make deck deployable at a *real* estate with minimal bespoke, work-around-y effort — so
an operator ships a container, points it at their inventory and a snapshot, and gets a robust hub
without patching around engine limitations. deck stays a **generic engine**; every item here keeps
that generality (nothing estate-specific belongs in deck).

**Source of this plan:** the findings from the first real deployment (onto the `gnet-lg` estate,
tracked in that repo's `DECK-INTEGRATION-PLAN.md`). That deployment confirmed the engine is
sound — v0.1.0 deploys end-to-end with **no hard blockers**. The items below are the friction
points and polish that surfaced, ranked by how much operator work they remove.

**Tracked in:** [#26 (epic)](https://github.com/garygentry/deck/issues/26) → H1 #16 · H2 #17 · H3 #18 · H4 #19 · H5 #20 · H6 #21 · H7 #22 · H8 #23 · H9 #24 · H10 #25.

**Status legend:** `[ ]` todo · `[~]` in progress · `[x]` done. Keep honest.

---

## How deck is deployed today (baseline)

One Bun process (web + `/api`), one port, state outside the image (a mounted `/config` estate + a
snapshot file/URL), fronted by an operator-provided authenticating reverse proxy. The image is
built by the operator from source; there is **no published registry image and no IaC** in the repo
(by design — `docs/architecture/deployment.md`). An estate produces its own snapshot from its own
collector against the documented `snapshot.schema.json` contract; deck ships no collector (also by
design — deck reads reality, it doesn't observe it).

Those two "by design" choices are correct for a *generic* engine, but they push real work onto
every estate. The items below reduce that work without compromising generality.

---

## P0 — Remove the biggest per-estate deploy chore

- [ ] **H1 — Publish a versioned container image to a registry (GHCR) on tag.**
  - *Problem:* today every estate builds the image from source on a host (the gnet-lg deployment
    builds `deck:<sha>` on its docker host, mirroring how pulse builds its own images). That is a
    recurring chore and a re-pin dance for each estate on every version bump.
  - *Approach:* a GitHub Actions release job that builds the existing multi-stage `Dockerfile` and
    pushes `ghcr.io/<owner>/deck:<version>` (and `:latest`) on a `v*` tag; multi-arch
    (`linux/amd64` + `linux/arm64`) via buildx so it runs on a Pi/ARM NAS too. Document pulling the
    pinned tag in `docs/guides/deploy.md` alongside the build-from-source path.
  - *Acceptance:* `docker run ghcr.io/<owner>/deck:v0.1.0` serves the app against a mounted estate;
    the deploy guide leads with the pinned image and keeps build-from-source as the fallback.
  - *Size:* S. *Leverage:* highest — removes on-host builds for every estate.

---

## P1 — Reduce collector/integration friction (generic helpers)

- [ ] **H3 — `deck snapshot validate <file>` CLI subcommand.**
  - *Problem:* `@deck/schema` exports `validateSnapshot`, but the `deck` CLI only does
    `validate`/`render` (config). An estate collector written in *any* language must import the TS
    package to self-test its output, or skip validation until deck rejects it at runtime.
  - *Approach:* add a `snapshot validate <file>` subcommand (and optionally `snapshot render` for a
    now-relative template, factoring the logic already in `scripts/make-example-snapshot.mjs`) that
    validates a snapshot document against the schema and reports findings with the same exit-class
    scheme as `validate` (0 clean / 1 findings / 2 tool error). A language-agnostic CI gate.
  - *Acceptance:* a collector's CI can shell out to `deck snapshot validate out.json` and fail on a
    malformed document; documented in `docs/guides/produce-a-snapshot.md`.
  - *Size:* S.

- [ ] **H4 — Prometheus `/metrics` endpoint for deck itself.**
  - *Problem:* deck exposes only `/api/health` (a 200/JSON liveness probe). An estate that already
    runs Prometheus can page on up/down but can't scrape deck's internals (per-provider poll
    health, poll latency, snapshot freshness/age, provider count).
  - *Approach:* an opt-in `/metrics` route (behind a `DECK_METRICS_ENABLED` flag) exposing provider
    poll success/failure, last-poll latency, and snapshot age gauges. Read-only, no auth (same
    posture as the rest — front with the proxy).
  - *Acceptance:* an estate Prometheus scrapes deck and can alert on a degraded provider or a stale
    snapshot from deck's own metrics; documented in `docs/guides/connect-monitoring.md`.
  - *Size:* M.

- [ ] **H2 — Production compose/packaging template (not just the example).**
  - *Problem:* `examples/compose.yaml` mounts the example estate; a real deployment hand-assembles
    the snapshot volume, sources cache dir, optional data dir, restart policy, and the
    reverse-proxy assumption. Fine, but repeated per estate.
  - *Approach:* ship a documented `deploy/compose.prod.yaml` template (image from H1; env for
    `DECK_SNAPSHOT_SOURCE`, `DECK_SOURCES_CACHE_DIR`, actions vars commented; named volumes;
    `restart: unless-stopped`) that an operator copies and repoints. Keep the example separate.
  - *Acceptance:* copy the prod template, set the image tag + two env vars, `docker compose up` →
    running deck against your estate. Guide references it.
  - *Size:* S.

---

## P2 — Contract & schema coverage (iterative, driven by real snapshots)

- [ ] **H5 — Snapshot-contract coverage review against a real estate's reality.**
  - *Problem:* the estate's observed data is richer than the contract's first-class fields (e.g.
    disk/ZFS pools + SMART, timekeeping/NTP sync, TrueNAS datasets/shares, per-guest Proxmox
    detail). Today all of it lands in the open `facts{}` bag, which renders generically but loses
    structure deck could present well.
  - *Approach:* after the first real `gnet deck snapshot` transform exists, list the facts that
    recur across estates and deserve first-class, well-rendered fields (candidates: storage/pools,
    NTP/clock health, a hypervisor guest count). Promote the durable ones to the schema; leave
    truly estate-specific data in `facts{}`.
  - *Acceptance:* the common reality facts render as structured UI, not as raw `facts` blobs; schema
    changes are additive and versioned.
  - *Size:* M, iterative.

- [ ] **H6 — Host lifecycle status (parity with services).**
  - *Problem:* a `Service` has `status: active|planned|retired`, but a `Host` has only `hidden`. A
    real estate has retired/planned hosts (decommissioned VMs, unconfirmed nodes) it wants to show
    honestly rather than hide.
  - *Approach:* add an optional `status: active|planned|retired` to the Host schema, rendered like
    the service status; `hidden` stays orthogonal.
  - *Acceptance:* a retired host renders with a retired badge instead of being hidden or looking
    active; validation + docs updated.
  - *Size:* S.

- [ ] **H10 — Overlay-layer reference validation resolves against the merged doc, not the layer alone.**
  - *Problem (hit during the first real deployment):* deck validates each config layer standalone, and
    a layer's host/service reference check (service links, group items) resolves host refs against only
    the hosts declared **in that same layer**, not the base+overlay merge. In the natural "base declares
    inventory / overlay adds presentation (links, groups)" split, an overlay that adds a link to a
    base-declared host fails `REF_HOST_UNRESOLVED` — forcing the operator to re-declare bare host stubs
    in the overlay purely to satisfy the per-layer check. The merged document is always correct; only
    the per-layer gate is over-strict.
  - *Approach:* run cross-reference validation against the merged document (keep per-layer *schema*
    validation as-is); or teach the per-layer reference check to resolve against the union of layers.
  - *Acceptance:* an overlay can reference any host declared in any layer without re-declaring it;
    the base/overlay presentation split needs no stub hosts.
  - *Size:* S. *Papercut, but hit immediately on a real two-layer estate.*

- [ ] **H7 — Express "not compared" coverage in drift (design).**
  - *Problem:* a mature estate collector knows what it *did not* check (deck's own drift model is
    "collected/partial/unreachable" per host, but an estate like gnet-lg tracks an explicit
    `NOT_COMPARED` set — DNS records, VLAN topology, whether backups ran — so "clean" can't be
    mistaken for "clean on everything"). deck currently can't represent that honesty.
  - *Approach:* design-first. Consider an optional coverage/`notCompared` array on the snapshot (or
    a drift-coverage surface) so deck can show "clean on what was checked; these areas uncovered."
  - *Acceptance:* an operator can see coverage scope, not just findings. *Design spike before code.*
  - *Size:* M (design).

---

## P3 — Nice-to-have

- [ ] **H8 — Optional built-in auth (revisit the v0.1.0 doc-only decision).** The reverse-proxy
  model is correct and should stay the default, but an opt-in basic-auth/OIDC-header mode would let
  estates without a proxy deploy safely. Low priority while the proxy assumption holds. *Size:* M.

- [ ] **H9 — Snapshot source: watch/refresh signal.** deck re-reads the source every 60s (fine).
  A future optimization: an opt-in webhook/`SIGHUP` to refresh on demand when a collector finishes,
  instead of waiting up to a poll interval. *Size:* S. *Only if the 60s poll proves too slow.*

---

## Explicitly NOT deck's job (kept out on purpose)

- **A built-in collector.** deck reads a snapshot; the estate produces it. Generality depends on
  this split. H3 (a validate CLI) is the right amount of help — a *contract self-test*, not a
  collector.
- **Estate-specific config generation.** Projecting an estate's inventory into deck's schema is the
  estate's job (e.g. gnet-lg's `gnet deck estate`). deck's contribution is a stable, well-documented
  schema + `deck validate`.
- **Infrastructure-as-code / reverse proxy / TLS / DNS.** Operator-provided, outside deck's
  boundary (`docs/architecture/deployment.md`).

---

## Suggested sequencing

1. **H1** (publish image) — unblocks clean pinning everywhere; do first.
2. **H3 + H2** (snapshot-validate CLI + prod compose) — small, remove collector/deploy friction.
3. **H4** (`/metrics`) — lets an estate monitor deck itself.
4. **H5/H6/H7** — schema/contract work, driven by what the first real snapshot transform reveals.
5. **H8/H9** — only if a concrete need appears.

Each is a candidate feature-forge feature (`/feature-forge:forge-1-prd <slug>`); H1/H2/H3 are small
enough to do directly. Nothing here blocks an estate from deploying v0.1.0 today.
