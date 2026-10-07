# Produce and refresh a snapshot

A snapshot is the observed-reality half of an estate: the hosts, services, and drift
findings that a collector you run has actually seen.
Deck never observes your estate itself — it only reads a snapshot document and shows it beside
your declared config.
This guide points deck at a snapshot, generates one from a template, and keeps it fresh so the
Hosts, Services, and Drift surfaces stay trustworthy.

For the field-by-field shape of the document (envelope, observed hosts and services, coverage
states, drift findings, and waivers), see the
[snapshot contract reference](../reference/snapshot-contract.md).
For why coverage and freshness are judged the way they are, see
[Inventory beside reality](../explanation/drift-and-coverage.md).

## Point deck at a snapshot

Set `DECK_SNAPSHOT_SOURCE` to tell deck where the snapshot lives.
It accepts one of two forms, resolved once at startup:

- a **file path** — deck reads the file (relative paths resolve against the server's startup
  working directory);
- an **`http(s)` URL** — deck fetches it.

```bash
# A file on disk...
DECK_SNAPSHOT_SOURCE=./estate/snapshot.json bun apps/server/src/server/boot.ts

# ...or an endpoint your collector publishes to.
DECK_SNAPSHOT_SOURCE=https://inventory.your-lan.example/snapshot.json \
  bun apps/server/src/server/boot.ts
```

Once set, the snapshot feeds the observed side of three surfaces: **Hosts** and **Services**
gain their observed state and per-host freshness, and **Drift** gains its findings and coverage
rows.
Leave `DECK_SNAPSHOT_SOURCE` unset and deck does not register the snapshot provider at all —
those surfaces show declared inventory only, with no observed state.

Deck re-reads the source on every poll (every 60 seconds), using a conditional read — file
modification time and size, or HTTP `ETag`/`Last-Modified` — so an unchanged document costs
almost nothing and a changed one is picked up on the next poll.
Refreshing is therefore just updating what the source points at; there is no restart.
A document that fails to parse or validate leaves the last accepted snapshot in place and
surfaces as a degraded snapshot provider on `/api/health`, rather than crashing the server or
blanking the surfaces.

When you deploy in a container, set `DECK_SNAPSHOT_SOURCE` the same way — see
[Deploy deck](deploy.md) for mounting a snapshot file or fronting an HTTP source, and the
[environment variables reference](../reference/environment-variables.md) for the full list of
`DECK_*` settings.

## Generate one from a template

For the bundled example — and for any estate that would rather template a snapshot than hand-
write one — deck ships a generator that stamps timestamps relative to "now" at generation time.
This matters because deck judges freshness against the wall clock: a snapshot with fixed
timestamps ages into "stale" as time passes, so a demo needs its timestamps refreshed each time
it is produced.

Run the bundled example generator:

```bash
pnpm snapshot:example
```

That runs `scripts/make-example-snapshot.mjs`, which reads
`examples/estate/snapshot.template.json`, converts its `_*AgoMinutes` and `_untilInDays` helper
hints into RFC 3339 timestamps relative to now, strips every `_`-prefixed helper key, and writes
a valid snapshot to `examples/estate/.runtime/snapshot.json` (gitignored).
The `dev` and `start` scripts run this step for you before booting, so `pnpm dev` always serves a
fresh-looking example.

Point the generator at your own template and output path with `--template` and `--out`:

```bash
node scripts/make-example-snapshot.mjs \
  --template ./estate/snapshot.template.json \
  --out ./estate/.runtime/snapshot.json
```

The container image does this automatically for a templated estate: if
`DECK_SNAPSHOT_SOURCE` is unset **and** `${DECK_CONFIG_DIR}/snapshot.template.json` exists, the
entrypoint materializes a now-relative snapshot into a writable runtime path (default
`/tmp/deck/snapshot.json`, overridable with `DECK_SNAPSHOT_OUT`) and points
`DECK_SNAPSHOT_SOURCE` at it.
A real deployment that points `DECK_SNAPSHOT_SOURCE` at a real snapshot skips this entirely.

The template mechanism is a convenience for demos and fixtures.
A production estate should produce its snapshot from a real collector — a script, a cron job, or
a CI pipeline that inspects your hosts and writes a valid document — and keep it fresh as
described next.

## Keep it fresh

Deck reads freshness from timestamps **inside** the snapshot against the wall clock, so a
stalled collector naturally surfaces as stale hosts — which is the point.
Each collected host carries a `collectedAt`, and a host reads **stale** once its age exceeds the
threshold, **fresh** otherwise.

The threshold is `estate.freshness.snapshotStaleAfter`, a positive ISO-8601 duration in your
estate config, defaulting to `PT24H` (24 hours) when omitted.
The bundled example sets it in `examples/estate/10-overlay.yaml`:

```yaml
estate:
  freshness:
    snapshotStaleAfter: P2D
```

To keep hosts reading fresh, refresh the snapshot on a cadence at or under that window.
The loop is the same whichever source form you use:

1. **Collect** — inspect each host and build a snapshot document, stamping `generatedAt` and each
   host's `collectedAt` with the real observation time.
2. **Publish** — for a file source, write it atomically (write a temp file, then rename) so deck
   never reads a half-written document; for an HTTP source, upload it to the URL deck fetches.
3. **Schedule** — run that on a timer — cron, a systemd timer, or CI — at or under your
   `snapshotStaleAfter` window (for example, hourly for a `PT24H` threshold).

A cron entry for a file source:

```cron
# Refresh the snapshot hourly, writing atomically to the path deck reads.
0 * * * *  /usr/local/bin/collect-estate-snapshot > /var/lib/deck/snapshot.json.tmp \
             && mv /var/lib/deck/snapshot.json.tmp /var/lib/deck/snapshot.json
```

## Validate before you publish

Validate what you produce against the published contract in your collector's own tests or CI, so
a malformed document is caught before deck reads it. Deck ships a CLI subcommand for exactly this
— a language-agnostic gate your collector can shell out to, whatever it is written in:

```bash
deck snapshot validate ./estate/.runtime/snapshot.json
```

It validates the document against the snapshot schema and reports findings with the same
exit-class scheme as `deck validate`:

- **`0`** — clean (advisory-only findings still exit `0`, printed for visibility);
- **`1`** — the document has errors (printed as `severity  path  code  message` lines);
- **`2`** — a tool error (the file is missing/unreadable, or is not valid JSON).

Wire it into your collector's CI so a malformed snapshot fails the build at the source:

```bash
# In the collector's pipeline, after writing the document:
deck snapshot validate out.json || exit 1
```

The check is schema + structural (envelope shape, version, duplicate hosts/services/drift ids); it
does not need deck's config. The underlying `validateSnapshot` is also exported from `@deck/schema`
for TypeScript collectors that prefer an in-process call. The published schema itself lives at
`packages/schema/schema/snapshot.schema.json` (also exported from `@deck/schema`), and the
[snapshot contract reference](../reference/snapshot-contract.md) documents every field it enforces.
