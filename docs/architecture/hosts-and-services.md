# Hosts and services inventory

Deck presents declared estate intent beside the latest observed host and service state. The server owns snapshot ingestion and caching; the browser combines the cached snapshot with `/api/config` into an immutable inventory model.

## Runtime flow

1. `apps/server/src/server/boot.ts` loads estate configuration.
2. When `DECK_SNAPSHOT_SOURCE` is present, provider registration creates one `snapshot` provider.
3. The provider polls its source, validates changed documents, derives host collection state, and publishes a cached provider envelope.
4. `/api/providers/snapshot` serves that envelope without performing source I/O in the request path.
5. The browser polls `/api/providers/snapshot` and pairs each envelope with the config (read once per page load through the shared data layer) as one generation, then atomically commits the resulting inventory model.

A failed refresh does not overwrite the last accepted snapshot. Provider freshness describes whether polling succeeds; each host's collection state independently describes the age and coverage of its observation.

## Routes

The inventory registers four SPA routes:

- `/hosts` — declared and observed hosts
- `/services` — declared services grouped by host
- `/hosts/:name` — one host's intent and observed state
- `/services/:host/:name` — one service's intent and observed state

Only the two list routes appear in primary navigation. Detail routes remain directly addressable and linkable.

## Extension slots

Host and service detail pages render the sections other modules attach to `entity:host/sections` and `entity:service/sections`, in order: today drift's Findings, then sources' Configs. The pages own no list of sections, so any module can add one (see "Entity sections" in `ui.md`). Each fragment is isolated by an error boundary so a failing extension cannot blank the detail page or a sibling section.

## Snapshot configuration

### Source

Set `DECK_SNAPSHOT_SOURCE` before starting the server:

```bash
DECK_SNAPSHOT_SOURCE=./estate/snapshot.json bun apps/server/src/server/boot.ts
```

```bash
DECK_SNAPSHOT_SOURCE=https://inventory.example.test/snapshot.json \
  bun apps/server/src/server/boot.ts
```

Accepted values are:

- a file path; relative paths are resolved once against the server's startup working directory
- an `http://` or `https://` URL

When the variable is absent, Deck does not register the snapshot provider and the browser reports that observed inventory is not configured. Empty values, malformed HTTP(S) URLs, and unsupported URI schemes fail startup with a sanitized configuration error. File and HTTP response bodies have a fixed 50 MiB limit; this safety bound is not configurable.

Do not place credentials in the source value. Use an appropriately protected local file or an HTTP endpoint whose network access is controlled outside Deck.

### Host stale threshold

The optional estate setting `estate.freshness.snapshotStaleAfter` is a positive ISO-8601 duration:

```yaml
estate:
  freshness:
    snapshotStaleAfter: PT6H
```

The default is `PT24H`. A present value that is malformed, zero, negative, overflowing, or non-finite is rejected rather than replaced by the default.

### Polling and freshness

The snapshot provider uses fixed timing:

- source poll interval: 60 seconds
- provider TTL: 60 seconds
- unreachable threshold: 180 seconds
- per-poll timeout: 5 seconds

The browser refreshes its config/snapshot generation every 30 seconds by default. These timings are implementation constants rather than operator settings.

Host collection states are:

- `never-collected` — declared intent exists without an observation
- `fresh` — a complete observation is within the stale threshold
- `stale` — a complete observation is older than the stale threshold
- `partial` — collection explicitly reports partial coverage
- `unreachable` — collection reports an unreachable host or has an invalid timestamp/coverage combination

Future collection timestamps clamp age to zero. Snapshot-provider errors and host collection state remain distinct in the API and UI.
