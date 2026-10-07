# Provider kinds reference

deck ships nine provider kinds.
A provider polls one backend (or serves static or source data) on a schedule and
caches the latest result as an envelope the web app reads.
This page lists each kind and its configuration.

## How providers are configured

A provider is registered from one of four config surfaces, depending on its kind:

| Surface | Kinds | Where it is declared |
| --- | --- | --- |
| Integration | `docker`, `gatus`, `prometheus`, `alertmanager` | `integrations[]` entry |
| Binding | `http-health`, `link` | `bindings` map on a host or service |
| Source | `file-tree`, `markdown-tree` | `sources[]` entry |
| Runtime | `snapshot` | `DECK_SNAPSHOT_SOURCE`, not the estate config |

For the integration-backed kinds, deck registers at most one provider per kind:
the first integration of each kind is registered under a fixed id equal to the
kind (`docker`, `gatus`, `prometheus`, `alertmanager`), and any later same-kind
integration is skipped by the poller.
A binding-backed provider is registered per host/service binding, and a
source-backed provider is registered per declared source.

Every dynamic provider is polled on a shared schedule.
The defaults are a 30-second poll interval, a 30-second freshness TTL, a
90-second unreachable threshold, and a 5-second per-poll timeout.
Only the `http-health` binding accepts a per-provider `timing` override; the
`snapshot` provider uses its own fixed schedule (see below), and the other kinds
use the defaults.

Polling never blocks a request: `GET /api/health` and `GET /api/providers/:id`
return the cached envelope and health without upstream I/O.

## alertmanager

Reads active alerts and silences from a Prometheus Alertmanager instance.
Backed by an integration.

| Key | Required | Notes |
| --- | --- | --- |
| `baseUrl` | yes | Alertmanager base URL; deck calls `GET /api/v2/alerts` and `GET /api/v2/silences` under it. |
| `credentialEnv` | no | Environment-variable name whose value is sent as the `Authorization` header. |

A non-2xx from either endpoint is treated as a failure (not "all clear"), so an
unreachable Alertmanager reports as degraded.

## docker

Lists containers from a Docker Engine API endpoint (typically a socket proxy).
Backed by an integration.

| Key | Required | Notes |
| --- | --- | --- |
| `baseUrl` | yes | Engine API base URL; deck calls `GET /containers/json?all=true` under it. |
| `credentialEnv` | no | Environment-variable name whose value is sent as the `Authorization` header. |

A non-2xx upstream marks the provider unhealthy rather than reporting zero
containers as healthy.

## file-tree

Publishes a read-only file tree from an estate source, rendered on the Configs
surface.
Backed by a source; behaves identically to `markdown-tree` apart from the
surface that consumes it.

| Key | Required | Notes |
| --- | --- | --- |
| `location.path` | one of path/repo | Filesystem path to the source root. |
| `location.repo` | one of path/repo | Repository reference; `location.ref` optionally pins a revision or branch. |
| `include` | no | Include glob patterns. |
| `exclude` | no | Exclude glob patterns. |
| `credentialEnv` | no | Environment-variable name for a credential used when acquiring a private repo. |

Registered under the source `id`.
Uses the default polling schedule (no per-source `timing` field).

## gatus

Reads endpoint statuses from a Gatus health-dashboard instance.
Backed by an integration.

| Key | Required | Notes |
| --- | --- | --- |
| `baseUrl` | yes | Gatus base URL; deck calls `GET /api/v1/endpoints/statuses` under it. |
| `credentialEnv` | no | Environment-variable name whose value is sent as the `Authorization` header. |

Each endpoint's `up` state and latency are taken from its most recent result.
A non-2xx upstream marks the provider unhealthy.

## http-health

Probes a single URL and reports whether it is up, its status code, and its
latency.
Backed by a `http-health` binding on a host or service.

| Key | Required | Notes |
| --- | --- | --- |
| `url` | yes | The URL to probe. |
| `method` | no | `GET` (default) or `HEAD`. |
| `id` | no | Provider id; defaults to a value derived from the owning host/service. |
| `order` | no | Sort order among providers. |
| `timing` | no | Per-provider poll overrides (`pollIntervalMs`, `ttlMs`, `unreachableAfterMs`, `timeoutMs`). |

A response status in the 200–399 range counts as up.
This kind sends no authorization header and has no `credentialEnv` support.

## link

Serves a static link descriptor (label, href, optional icon) for the portal — no
polling and no network I/O.
Backed by a `link` binding on a host or service.

| Key | Required | Notes |
| --- | --- | --- |
| `href` | yes | Link target URL. |
| `label` | no | Display label; defaults to the owning entity id. |
| `icon` | no | Icon name. |
| `id` | no | Provider id; defaults to a value derived from the owning host/service. |
| `order` | no | Sort order among providers. |

Its freshness state is always `static`.
No `credentialEnv` support.

## markdown-tree

Publishes a read-only file tree from an estate source, rendered on the Docs
surface.
Backed by a source; identical to `file-tree` apart from the surface that consumes
it.

| Key | Required | Notes |
| --- | --- | --- |
| `location.path` | one of path/repo | Filesystem path to the source root. |
| `location.repo` | one of path/repo | Repository reference; `location.ref` optionally pins a revision or branch. |
| `include` | no | Include glob patterns. |
| `exclude` | no | Exclude glob patterns. |
| `credentialEnv` | no | Environment-variable name for a credential used when acquiring a private repo. |

Registered under the source `id`.
Uses the default polling schedule (no per-source `timing` field).

## prometheus

Runs one PromQL query per summary tile and classifies each result against
thresholds.
Backed by an integration.

| Key | Required | Notes |
| --- | --- | --- |
| `baseUrl` | yes | Prometheus base URL; deck calls `GET /api/v1/query` under it. |
| `credentialEnv` | no | Environment-variable name whose value is sent as the `Authorization` header. |
| `card.summaries` | no | Array of summary queries; an absent or empty array yields no tiles. |

Each `card.summaries` entry:

| Key | Required | Notes |
| --- | --- | --- |
| `id` | yes | Summary id, unique within the card. |
| `label` | yes | Display label. |
| `query` | yes | PromQL query returning a scalar or single-sample vector. |
| `unit` | no | Display unit. |
| `warning` | no | Warning threshold; requires `direction`. |
| `critical` | no | Critical threshold; requires `direction`. |
| `direction` | no | `above` or `below`; required when a threshold is set. |

A summary with no threshold is classified `neutral`.
Invalid summary entries are dropped at load without failing boot; the provider is
unhealthy only when every query is unreachable.

## snapshot

Reads, validates, and serves the observed-reality snapshot that feeds Hosts,
Services, and Drift.
Not configured through the estate document — deck registers it only when
`DECK_SNAPSHOT_SOURCE` is set to a file path or HTTP(S) URL.

| Setting | Notes |
| --- | --- |
| `DECK_SNAPSHOT_SOURCE` | File path or HTTP(S) URL of the snapshot document. |

Registered under the fixed id `snapshot`.
It uses a fixed schedule — a 60-second poll interval, a 60-second TTL, and a
180-second unreachable threshold — and retains the last-good snapshot on a failed
read.
No `credentialEnv` support.
For the document shape it consumes, see the
[Snapshot contract reference](./snapshot-contract.md).
