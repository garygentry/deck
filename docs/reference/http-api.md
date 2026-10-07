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

`HealthResponse.status` is `degraded` when any provider's latest health is not ok, otherwise `ok`.

## Metrics

When `DECK_METRICS_ENABLED` is true, deck also serves `GET /metrics` — outside `/api` — as
Prometheus text exposition (`Content-Type: text/plain; version=0.0.4`), built from cached
registry state with no upstream I/O.
When the flag is off the route is not registered.
See [Connect monitoring](../guides/connect-monitoring.md#scrape-decks-own-metrics) for the
metric names.

## Sources

The four source-browsing routes are read-only (`GET`) and gate on the sources capability.
When the capability is off, or the id is not a declared source, the route answers 404
`SOURCE_NOT_FOUND`, so a disabled deployment is indistinguishable from an unknown id.

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

Present when the estate config has an `llmUsage` section; the read routes answer
`enabled: false` otherwise.
Every read counts as a viewer, which keeps upstream polling awake (see `idlePause`).

| Method | Path | Purpose | Response |
| --- | --- | --- | --- |
| `GET` | `/api/llm-usage` | Current usage bars, per-source states and poll state. Performs no upstream I/O. | `LlmUsageResponse` |
| `GET` | `/api/llm-usage/refresh` | The same after an immediate poll, debounced to once per 5 seconds. Codex is always re-read; the Claude OAuth endpoint only if its last call was 2+ minutes ago and deck is not backing off. | `LlmUsageResponse` |
| `POST` | `/api/llm-usage/ingest` | A Claude Code statusLine payload (JSON, at most 2 MB), with `Authorization: Bearer <token>`. Registered only when the env var named by `llmUsage.claude.statusLine.credentialEnv` is set. | 204, empty body |

`/api/health` gains an `llmUsage` entry (`mode`, `lastPollAt`, `consecutiveErrors`) when the
feature is on. It never changes the overall health `status`.

## Errors

API errors share one envelope.

```json
{ "error": "human-readable message", "code": "MACHINE_CODE" }
```

`error` is always present; `code` is present for classified errors.

| Code | Status | Meaning |
| --- | --- | --- |
| `NOT_FOUND` | 404 | An `/api/*` path with no matching route. |
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
