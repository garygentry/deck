# Deploy deck

This guide runs deck against your own estate in production: the container, the config and
snapshot volumes, the health check, and the reverse proxy in front of it.
Deck is a single long-running process — one Bun server that serves the built web app **and** the
`/api` it talks to.
There is no separate frontend to host and no database to provision; the only state deck needs is
your estate config (mounted) and an observed-reality snapshot (a file or URL).

For every `DECK_*` variable and its default, see the
[environment variables reference](../reference/environment-variables.md).
For producing and refreshing the snapshot, see
[Produce and refresh a snapshot](produce-a-snapshot.md).

## Run the container

Each tagged release publishes a versioned, multi-arch image (`linux/amd64` + `linux/arm64`, so it
runs on a Pi or ARM NAS too) to the GitHub Container Registry. Pull a **pinned** tag and run it
against your estate, mounted read-only at `/config`:

```bash
# Pull a pinned release (see the repo's tags/releases for the current version).
docker run -d --name deck \
  -p 8080:8080 \
  -v /path/to/your/estate:/config:ro \
  ghcr.io/garygentry/deck:0.3.2

# Open http://localhost:8080
```

Pin an explicit version rather than `:latest` so a deploy is reproducible and an upgrade is a
deliberate tag bump. The container entrypoint supplies deployment-sensible defaults —
`DECK_CONFIG_DIR=/config`, `DECK_WEB_DIST=/app/apps/web/dist`, and `DECK_PORT=8080` — and every
other `DECK_*` variable passes straight through with `-e`.
Because web and API are one process, you publish only the single `DECK_PORT`.

For a production deployment, copy the [`deploy/compose.prod.yaml`](../../deploy/compose.prod.yaml)
template, set the image tag and your two env vars, and `docker compose up` — see
[Wire config and snapshot](#wire-config-and-snapshot) below.

### Build from source (fallback)

If you would rather build the image yourself — an air-gapped host, or a change you have not
tagged — the repository ships a multi-stage [`Dockerfile`](../../Dockerfile). The builder stage
installs the workspace and builds the web bundle with Vite; the runtime stage is Bun serving that
`dist` plus `/api` from one process.

```bash
# Build, then run the same way as the pulled image.
docker build -t deck:local .
docker run -d --name deck -p 8080:8080 -v /path/to/your/estate:/config:ro deck:local
```

To smoke-test that your host can build and serve the image against the bundled example estate, use
the example Compose file, which builds locally and mounts `./estate` at `/config:ro`:

```bash
cd examples
docker compose up --build      # → http://localhost:8080
```

## Wire config and snapshot

Deck reads two things from outside the image: your estate config and your snapshot.

Mount your estate config directory at `/config` (matching the default `DECK_CONFIG_DIR`);
read-only (`:ro`) is fine, since deck never writes to it.
Validate it before you deploy so a bad layer fails on your terminal rather than in the
container:

```bash
bun apps/server/src/cli/deck.ts validate /path/to/your/estate
```

See [Configure your estate](configure-your-estate.md) for authoring the config layers.

Point `DECK_SNAPSHOT_SOURCE` at your snapshot — a file mounted into the container, or an
`http(s)` URL your collector publishes to:

```bash
docker run -d --name deck \
  -p 8080:8080 \
  -v /path/to/your/estate:/config:ro \
  -v /path/to/snapshot.json:/snapshot.json:ro \
  -e DECK_SNAPSHOT_SOURCE=/snapshot.json \
  deck:local
```

Deck re-reads the source on each poll, so a collector that rewrites that file (or the URL's
content) refreshes the observed surfaces with no restart.
[Produce and refresh a snapshot](produce-a-snapshot.md) covers generating one and keeping it
current.

If your estate declares git-repo sources, give deck a writable cache volume via
`DECK_SOURCES_CACHE_DIR` so it does not re-clone on every restart; if you enable governed
actions, mount a writable, persistent `DECK_DATA_DIR` for the audit log.
Both, and the rest of the deployment settings, are in the
[environment variables reference](../reference/environment-variables.md).

## Health and restarts

`GET /api/health` returns HTTP 200 with a JSON body summarizing the server and each provider:

```json
{
  "status": "ok",
  "uptimeMs": 15184,
  "providerCount": 3,
  "providers": {
    "snapshot":     { "kind": "snapshot",     "ok": true, "detail": "Snapshot clean" },
    "host-configs": { "kind": "file-tree",    "ok": true, "detail": "4 files" },
    "runbooks":     { "kind": "markdown-tree", "ok": true, "detail": "4 files" }
  }
}
```

The image's Docker `HEALTHCHECK` already polls this endpoint on an interval; use the same path
for an orchestrator liveness/readiness probe or an external uptime monitor.

Run the container under a restart policy — the example Compose file uses `restart:
unless-stopped` — so it comes back after a crash or host reboot.
Boot is fail-fast: an unreadable config, an uncreatable sources cache, or an invalid actions
configuration stops startup with a classified error on stderr rather than starting a half-
configured server.
If the container exits on start, read `docker logs deck` for that message.

## Front with an authenticating proxy

Deck serves plain HTTP and has **no built-in authentication** — it treats every request that
reaches it as trusted.
The intended deployment is behind an authenticating reverse proxy on your private network that
terminates TLS and enforces access (SSO, basic auth, an identity-aware proxy, a VPN or tailnet).

Point the proxy at the container's `DECK_PORT`, and forward both `/` and `/api` to the same
upstream — they are one process.
A minimal Caddy example:

```caddyfile
deck.your-lan.example {
    reverse_proxy 127.0.0.1:8080
}
```

Do not expose the container port directly to an untrusted network.
See [Access and security model](../security.md) for the full posture — what deck protects, and
what it leaves to you.
