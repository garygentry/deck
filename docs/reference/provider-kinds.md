# Provider kinds reference

deck ships eleven provider kinds.
A provider polls one backend (or serves static or source data) on a schedule and
caches the latest result as an envelope the web app reads.
This page lists each kind and its configuration.

## How providers are configured

A provider is registered from one of four config surfaces, depending on its kind:

| Surface | Kinds | Where it is declared |
| --- | --- | --- |
| Integration | `docker`, `gatus`, `prometheus`, `alertmanager`, `http-json`, `remote` | `integrations[]` entry |
| Binding | `http-health`, `link` | `bindings` map on a host or service |
| Source | `file-tree`, `markdown-tree` | `sources[]` entry |
| Runtime | `snapshot` | `DECK_SNAPSHOT_SOURCE`, not the estate config |

For the `docker`, `gatus`, `prometheus` and `alertmanager` integrations, deck registers at
most one provider per kind: the first integration of each kind is registered under a fixed id
equal to the kind, and any later same-kind integration is skipped by the poller. Every
`http-json` and `remote` integration is registered under its own `id`.
A binding-backed provider is registered per host/service binding, and a
source-backed provider is registered per declared source.

`link`, `http-health`, `http-json`, `remote`, `docker`, `gatus`, `prometheus`, `alertmanager`
and `snapshot` are each a data-source module that owns its kind: the module declares the kind and
turns its bindings and integration instances into providers. A `docker` or
`gatus` binding registers no provider of its own; it selects entries from the
integration's provider for the portal's card status. A kind that is `bindable` and
`statusCapable` may declare `status` in its manifest: which provider a binding reads (its
own, or the kind's fixed instance), how the bound item is found in that provider's data, and
which field values mean up. `docker`, `gatus` and `http-health` declare one, and the portal
derives every card's status from these declarations, so a new data source's bindings drive
cards with no portal code. Reading the kind's fixed instance (`provider: "fixed"`) is for
built-in modules only, as fixed ids are; another module declaring it is refused
(MODULE_MANIFEST_INVALID). A bindable, status-capable kind with no `status` is reported in
`GET /api/ui` (`UI_STATUS_UNDECLARED`). `prometheus`,
`alertmanager` and `snapshot` do not accept bindings: a host or service binding
of any of them is ignored and reported as `PROVIDER_BINDING_UNSUPPORTED` (info), and so is a
binding of `http-json`.
The `prometheus` and `alertmanager` provider ids are fixed: another provider
declared with either id (a binding's `id`, say) fails boot with
`PROVIDER_DUPLICATE_ID`.

Every dynamic provider is polled on a shared schedule.
The defaults are a 30-second poll interval, a 30-second freshness TTL, a
90-second unreachable threshold, and a 5-second per-poll timeout.
Only the `http-health` binding (`timing`) and the `http-json` integration (`pollIntervalMs`,
`ttlMs`, `timeoutMs`) accept per-provider timing; the `snapshot` provider uses its own fixed
schedule (see below), and the other kinds use the defaults.

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
unreachable Alertmanager reports as degraded. When either request fails, the other is
cancelled, so a failed poll leaves no request open.

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

## http-json

Polls any HTTP API that answers JSON, and serves the parsed body as the envelope's `data`
(a JSON `null` included). It is the no-code way to bring a service deck has no kind for onto a
dashboard.
Backed by an integration; each instance is its own provider, registered under its `id`.

| Key | Required | Notes |
| --- | --- | --- |
| `id` | yes | Integration id, and the provider id (`GET /api/providers/<id>`). Taking the fixed provider id of another integration in the estate (`prometheus` beside a `prometheus` integration, say) is `PROVIDER_ID_RESERVED`. |
| `title` | yes | Display title. |
| `url` | yes | The `http://` or `https://` URL polled, as the runtime's URL parser reads it. Any other scheme, a URL carrying `user:password@`, or one it cannot parse (a bad IPv6 host, a port over 65535) is `HTTP_JSON_URL_INVALID`. A query parameter whose name looks like a credential (see `headers`) is `HTTP_JSON_LITERAL_CREDENTIAL`: use `auth.scheme: query`. |
| `method` | no | `GET` (default) or `POST`. |
| `body` | no | A JSON request body, sent with `POST` only (as `application/json` unless `headers` sets `Content-Type`). A key anywhere in it whose name looks like a credential is `HTTP_JSON_LITERAL_CREDENTIAL`. |
| `headers` | no | Literal request headers. They are config, so never secret: a header whose name names a credential is `HTTP_JSON_LITERAL_CREDENTIAL`. A name names a credential when it holds a whole word such as `auth`, `authorization`, `token`, `secret`, `password`, `passwd`, `passphrase`, `session`, `cookie`, `credential`, `sig`, `signature` or `apikey`, the pairs `api key`, `access token`, `private key` and `client secret`, or a bare `key`, split at `_`, `-`, `.` and camelCase (so `X-Api-Key`, `accessToken` and `api_key` are credentials; `author`, `keys`, `sort_key` and `passed` are not). Values are printable ASCII (and tab). |
| `credentialEnv` | no | Environment-variable **name** holding the credential, read at every poll. |
| `auth` | no | How the credential is sent (needs `credentialEnv`); see below. |
| `pollIntervalMs` | no | Milliseconds between polls, 1000–86400000; default 30000. |
| `ttlMs` | no | Milliseconds the data stays fresh; default the poll interval. |
| `timeoutMs` | no | Milliseconds a whole poll may take (redirects and body included), 100–60000; default 5000. |
| `maxBytes` | no | The largest response body accepted, up to 16 MiB; default 1 MiB. |
| `followCrossOriginRedirects` | no | `true` follows a redirect to another origin; default `false`. Ignored with `credentialEnv`. See below. |
| `deepLink` | no | A link to the API's own UI, used by the integration's tile. |

`auth.scheme` is one of:

| Scheme | Header sent |
| --- | --- |
| (no `auth`) | `Authorization: <value>`, as the other integrations send it. |
| `bearer` | `Authorization: Bearer <value>`. |
| `basic` | `Authorization: Basic <base64 of value>`; the value is `user:password`. |
| `header` | `<auth.header>: <value>`, for an API key header such as `X-Api-Key`. |
| `query` | The `<auth.param>` query parameter set to the value, for an API that takes its key in the URL. The URL in config never holds it. |

An unset or empty credential variable, or one the module may not read
(`MODULE_CREDENTIAL_ENV_REFUSED`), fails the poll without sending a request. So does a value
shorter than **8 characters** or with leading or trailing whitespace: a header would trim the
padding, and a shorter value could not be told apart in the echo check above. So does a value a
header cannot carry (a line break, a control character, a character outside Latin-1) under the
`bearer`, `header` or default scheme; `basic` and `query` encode any value.

Redirects (301, 302, 303, 307, 308) are followed up to five times, within the configured URL's
origin (scheme, host and port) only: a redirect elsewhere, `http://` to `https://` included,
is refused (`cross-origin redirect refused`), so an endpoint cannot steer deck's poll to another
host on its network, deck's own loopback API included. An authenticated request sends the
credential on each hop. An unauthenticated instance may set `followCrossOriginRedirects: true`
to follow redirects to any http(s) origin, for an API that answers from elsewhere (a CDN or an
object store, say). An authenticated request never does, since the `Location` could itself
carry the credential: the setting is ignored with `credentialEnv`
(`HTTP_JSON_REDIRECT_OPT_IN_IGNORED`, a warning). Even with the opt-in, a redirect to
`localhost` or to a literal loopback, link-local or unspecified address (127.0.0.0/8,
0.0.0.0/8, 169.254.0.0/16, `::1`, `::`, fe80::/10, or one of these IPv4-mapped) is refused
(`redirect to a loopback, link-local or unspecified address refused`). That check reads the
address as written and makes no DNS lookup, so a hostname that resolves to an internal address
(deck's own host included) is still followed: opt in only for an upstream you trust. A redirect to a non-http(s) URL or to a URL
with `user:password@` is refused. A 303, or a 301 or
302 answering a `POST`, is followed with a `GET` and no body.

A response is refused, never published, when it nests arrays and objects more than 64 levels
deep (checked before parsing), or when any string or key in it contains the credential, raw or
as sent (the `Bearer` value, the base64 `Basic` pair, the URL-encoded value, the exact header
value the runtime sends).

A failed poll keeps the last good data and publishes one of these errors. None ever contains
the credential, the response body or the runtime's own error text:

| Failure | Error message |
| --- | --- |
| Credential variable unset or unreadable | `credential variable <NAME> is not set or not readable by this module (see MODULE_CREDENTIAL_ENV_REFUSED)` |
| Credential a header cannot carry | `credential variable <NAME> holds a character a header cannot carry` |
| A literal credential in the URL query or body | `url query parameter <name> looks like a credential; …` |
| Connection refused, DNS failure | `upstream unreachable (<code>)` |
| No complete response in time | `timed out after <n>ms`, or `timed out (<code>)` for the runtime's own connect, header or body timeout |
| A status other than 2xx (or an unfollowed redirect) | `upstream answered HTTP <status>` |
| Body over `maxBytes` | `upstream response exceeds <n> bytes` |
| Body nested past 64 levels | `upstream response nests deeper than 64 levels` |
| Body not JSON | `upstream response is not JSON` |
| Body contains the credential | `upstream response contains the credential; not published` |
| Redirect refused | `cross-origin redirect refused`, `cross-origin redirect refused for an authenticated request`, `redirect to a loopback, link-local or unspecified address refused`, `redirect to a non-http(s) URL refused`, `more than 5 redirects`, … |

```yaml
integrations:
  - id: ups
    kind: http-json
    title: UPS
    url: http://nut-exporter.lan:9199/status.json
    credentialEnv: UPS_TOKEN        # the variable's name; set its value in the environment
    auth: { scheme: bearer }
    pollIntervalMs: 15000
```

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
Invalid summary entries are dropped at load without failing boot. A query error shows as that
summary in error, with the provider still healthy: Prometheus answered, so it is a problem with
the query, not an outage. A query error is a 400 (PromQL that does not parse), a 422 (a query it
cannot execute), or another 4xx whose body is Prometheus's own error document
(`{"status": "error", "errorType": …}`). Any other answer means the query never ran, and leaves
it unreachable: a connection failure, a 5xx, or a refusal of the endpoint itself (401 or 403,
404, 407, 429). The provider is unhealthy only when every query is unreachable. Its health then
names a refusal when one was seen (`Prometheus authentication refused (401)`, `Prometheus not a
Prometheus endpoint (404)`, `Prometheus rate limited (429)`, `Prometheus answered HTTP <status>`),
and otherwise reads `Prometheus endpoint unreachable`.

## remote

A sidecar speaking the [remote provider protocol](remote-provider-protocol.md): deck polls
`<url>/deck/v1/data` for its data and asks `<url>/deck/v1/describe` for the widgets, links and
nav entries it contributes, which render on the integration's own page. Backed by an
integration; each instance is its own provider, registered under its `id`. The request
hardening, credential handling and failure messages are `http-json`'s (above). The keys are in
the [protocol reference](remote-provider-protocol.md#configure-it-in-deck).

## snapshot

Reads, validates, and serves the observed-reality snapshot that feeds Hosts,
Services, and Drift.
Not configured through the estate document — the `snapshot` module, which owns
`DECK_SNAPSHOT_SOURCE`, registers it only when that variable is set to a file
path or HTTP(S) URL. A malformed value fails boot (exit class 2); a well-formed
but unreadable one registers and fails on its polls.

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
