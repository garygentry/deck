# Environment variables

deck is configured at deployment time through `DECK_*` environment variables.
They are deck-deployment settings, distinct from estate-config fields: timing, cache, and
capability switches live here, never in the estate config document.
Every variable is read at boot and, where noted, again per request or per poll.

Two default sets appear below: the value baked into the code (also used by the container image)
and, where it differs, the value the `pnpm dev` and `pnpm start` scripts set.

## Core

| Name | Default | Purpose |
| --- | --- | --- |
| `DECK_CONFIG_DIR` | `config` (relative to the working directory); `/config` in the container | Directory holding the estate config YAML layers that deck loads, merges, and validates at boot. |
| `DECK_PORT` | `8080`; `8788` under `pnpm dev` | TCP port the single Bun process listens on. A non-finite or non-positive value falls back to `8080`. |
| `DECK_SNAPSHOT_SOURCE` | unset | Location of the observed-reality snapshot: a file path or an `http(s)` URL. Owned by the `snapshot` module and read once at boot; when unset, no snapshot provider is registered. A malformed value (an unsupported protocol, an empty value) fails the boot with exit class 2. |
| `DECK_WEB_DIST` | unset; `/app/apps/web/dist` in the container | Directory of the built web bundle served as static assets. When unset, deck serves the API only (in dev the web dev server proxies `/api`). |
| `DECK_LOG_LEVEL` | `info` | pino log level for the process logger. |
| `DECK_METRICS_ENABLED` | `false` | Opt-in switch for the Prometheus `GET /metrics` endpoint. `true` or `1` (case-insensitive) enables it; any other value leaves the `metrics` module off, and `/metrics` answers 404. See [Connect monitoring](../guides/connect-monitoring.md#scrape-decks-own-metrics). |

The container image sets `DECK_CONFIG_DIR`, `DECK_WEB_DIST`, and `DECK_PORT` as image defaults;
see the [Dockerfile](../../Dockerfile).

## Sources and actions

| Name | Default | Purpose |
| --- | --- | --- |
| `DECK_SOURCES_CACHE_DIR` | `<os-tmpdir>/deck-sources-cache` | On-disk cache root for acquired git source trees. The directory is created recursively at boot; a creation failure fails the boot with exit class 2. |
| `DECK_ACTIONS_ENABLED` | `false` | Master switch for the governed-actions capability. `true` or `1` (case-insensitive) enables it; any other value leaves it off. |
| `DECK_DATA_DIR` | none | Module data root; it must be an absolute path. The actions audit store lives in `$DECK_DATA_DIR/actions`. Required when `DECK_ACTIONS_ENABLED` is true; boot fails otherwise. |
| `DECK_RUNNERS_FILE` | none | Path to the runner allowlist manifest. Required when `DECK_ACTIONS_ENABLED` is true; boot fails otherwise. |
| `DECK_ACTION_TIMEOUT_MS` | `600000` (10 minutes) | Maximum run duration in milliseconds. When set, it must be a positive integer, otherwise boot fails. |

The actions capability is off by default.
When it is off, `DECK_DATA_DIR`, `DECK_RUNNERS_FILE`, and `DECK_ACTION_TIMEOUT_MS` are not read
and the action routes refuse with HTTP 403 (see [HTTP API reference](./http-api.md)).
When it is on, a missing or invalid required setting fails the boot rather than starting a
half-configured write path.

## Container entrypoint

This variable is read only by the container entrypoint script, not by the server itself.

| Name | Default | Purpose |
| --- | --- | --- |
| `DECK_SNAPSHOT_OUT` | `/tmp/deck/snapshot.json` | Path the entrypoint writes the templated example snapshot to when `DECK_SNAPSHOT_SOURCE` is unset and a snapshot template is present. This is a convenience for the bundled example, not a mechanism for real deployments, which set `DECK_SNAPSHOT_SOURCE` directly. |

## Credential env vars

Credentials are referenced by name, not by value.
An estate config field named `credentialEnv` holds the NAME of an environment variable
(pattern `^[A-Z][A-Z0-9_]*$`), never a secret.
The named variable is defined per estate, and its value is supplied at deploy time in the
container or host environment.

Because the set of names is estate-defined, no fixed list of credential variables exists:
each `credentialEnv` on a source or integration introduces one variable that deck reads at
runtime to authenticate acquisition or polling.
It may not name a deployment setting in this reference or a variable a module owns (such as
`DECK_SNAPSHOT_SOURCE`): the instance's module may not read it, boot logs a
`provider.credential-env-refused` warning naming the variable, and `deck validate` reports
`MODULE_CREDENTIAL_ENV_REFUSED`.
`modules.llm-usage.claude.statusLine.credentialEnv` works the other way round: its value is the bearer
token deck *expects* on `POST /api/llm-usage/ingest`, and the route exists only while it is set.
Any name works, `DECK_*` included, except the deployment settings in this reference: a config
cannot point the module at those.
The secret value never enters the config document or the HTTP API surface.

## Related references

- [CLI reference](./cli.md) — the `deck` command reads `DECK_CONFIG_DIR` for its config directory.
- [HTTP API reference](./http-api.md) — routes gated by the sources and actions capabilities.
