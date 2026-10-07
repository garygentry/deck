# Connect monitoring and alerts

This guide wires deck to monitoring and health backends you already run, so the
monitoring overview and the health header show live data.
It covers the four integration-backed backends — Docker, Gatus, Prometheus, and
Alertmanager — and the per-service HTTP health check.

deck polls each configured backend on a schedule and caches the result; it never
proxies your browser to the backend.
Providers are read-only: deck issues `GET` requests only.

For the full per-kind key list, see the
[Provider kinds reference](../reference/provider-kinds.md).

## Declare an integration

Docker, Gatus, Prometheus, and Alertmanager are declared as estate
`integrations`.
Add them to a config layer (for example `10-overlay.yaml`) in your estate config
directory.

An integration requires `id`, `kind`, `title`, and `baseUrl`.
The `kind` selects the provider; `baseUrl` is the root URL deck appends each
backend's API path to.

```yaml
schemaVersion: 1
integrations:
  - id: gatus-api
    kind: gatus
    title: Gatus API
    baseUrl: "https://gatus.example.invalid"
  - id: docker-proxy
    kind: docker
    title: Docker socket proxy
    baseUrl: "http://docker-proxy:2375"
  - id: alertmanager-primary
    kind: alertmanager
    title: Alertmanager
    baseUrl: "https://alertmanager.example.invalid"
```

deck registers at most one provider per integration kind: the first integration
of each kind wins, and any later same-kind integration is ignored by the poller
(it can still render as a link card).
Each registered provider is exposed under a fixed id equal to its kind — `docker`,
`gatus`, `prometheus`, `snapshot` — regardless of the integration `id` you chose.

Prometheus reads its summary tiles from the integration `card.summaries` array.
Each summary needs an `id`, `label`, and PromQL `query`; add `warning`,
`critical`, and `direction` (`above` or `below`) to color a threshold, and `unit`
for display.

```yaml
schemaVersion: 1
integrations:
  - id: prometheus-primary
    kind: prometheus
    title: Prometheus
    baseUrl: "https://prometheus.example.invalid"
    card:
      summaries:
        - id: cpu
          label: CPU load
          query: "avg(node_load1)"
          warning: 4
          critical: 8
          direction: above
        - id: disk-free
          label: Disk free
          query: "min(node_filesystem_free_percent)"
          unit: "%"
          warning: 20
          critical: 10
          direction: below
```

An HTTP health probe is not an integration — it is a per-host or per-service
`binding` under the `http-health` kind, with a `url` to probe.
Add it to the host or service you want to watch; `method` (`GET` or `HEAD`) is
optional and defaults to `GET`.

```yaml
schemaVersion: 1
services:
  - name: beacon
    host: cirrus
    kind: docker-compose
    purpose: Portal service
    bindings:
      http-health:
        url: "https://beacon.example.invalid/healthz"
        method: GET
```

## Authenticate to a protected endpoint

If a backend requires authorization, name the environment variable that holds the
credential with `credentialEnv`.
`credentialEnv` holds an environment-variable **name**, never the secret value,
and the name must match `^[A-Z][A-Z0-9_]*$`.

```yaml
schemaVersion: 1
integrations:
  - id: prometheus-primary
    kind: prometheus
    title: Prometheus
    baseUrl: "https://prometheus.example.invalid"
    credentialEnv: PROMETHEUS_TOKEN
```

At poll time deck reads that variable and sends its value verbatim as the
`Authorization` request header.
Set the value to the complete header contents the backend expects, including any
scheme prefix.

```bash
export PROMETHEUS_TOKEN="Bearer eyJhbGciOi..."
```

When the variable is unset or empty, deck sends no `Authorization` header.
Supply the value at deploy time — in the container environment or the host shell
that launches deck — so the secret never enters your config repo.

`credentialEnv` is honored by the integration-backed providers (Docker, Gatus,
Prometheus, Alertmanager).
The `http-health` binding sends no authorization header, so point it at an
unauthenticated health endpoint.

## Verify it is polling

Restart deck so it reloads the config and registers the new providers.
Read the health endpoint (default port `8080`):

```bash
curl -s http://localhost:8080/api/health
```

The response reports overall status, uptime, the provider count, and per-provider
health keyed by provider id:

```json
{
  "status": "ok",
  "uptimeMs": 42000,
  "providerCount": 3,
  "providers": {
    "gatus": { "kind": "gatus", "ok": true, "detail": "12 endpoints" },
    "prometheus": { "kind": "prometheus", "ok": true, "detail": "2 summaries" },
    "alertmanager": { "kind": "alertmanager", "ok": true, "detail": "0 firing, 0 silence(s)" }
  }
}
```

`status` is `ok` only when every provider's latest health is `ok`; it is
`degraded` when any provider's latest poll failed.
A `degraded` status therefore points you at the failing provider through its entry
in `providers`, whose `detail` carries the error message (an HTTP status, a
timeout, or a connection error) — never the credential or payload.

Until a provider completes its first poll its entry reports `ok: false` with
`detail` "Awaiting first poll", and `status` is `degraded`; give it one poll
interval (30 seconds by default) and re-check.

To inspect a single provider's cached data and freshness, read its envelope:

```bash
curl -s http://localhost:8080/api/providers/prometheus
```

The envelope's `freshness.state` is `pending` before the first successful poll,
then `fresh`, `stale`, or `unreachable` as the cached data ages past its
thresholds.
For those thresholds and every provider's config keys, see the
[Provider kinds reference](../reference/provider-kinds.md).

## Scrape deck's own metrics

The providers above are deck *reading* your backends.
Separately, deck can expose its own internals for a Prometheus you run to scrape.
The endpoint is off by default; enable it with `DECK_METRICS_ENABLED`:

```bash
export DECK_METRICS_ENABLED=true
```

`true` or `1` (case-insensitive) turns it on; unset or any other value leaves it off, and
`GET /metrics` then returns 404.
The route lives at `/metrics`, outside the `/api` namespace, and serves the Prometheus text
exposition format (`Content-Type: text/plain; version=0.0.4`).
It is computed from cached registry state, so a scrape never triggers a provider poll.

```bash
curl -s http://localhost:8080/metrics
```

| Metric | Type | Labels | Meaning |
| --- | --- | --- | --- |
| `deck_provider_count` | gauge | — | Providers registered in deck. |
| `deck_provider_poll_success_total` | counter | `id`, `kind` | Completed polls that fetched successfully. |
| `deck_provider_poll_failure_total` | counter | `id`, `kind` | Completed polls that failed or timed out. |
| `deck_provider_last_poll_latency_seconds` | gauge | `id`, `kind` | Duration of the latest completed poll; absent until a provider's first poll completes. |
| `deck_snapshot_age_seconds` | gauge | — | Seconds since deck last successfully read the snapshot; absent when no snapshot source is configured or no read has succeeded. |

Counters reset when deck restarts.
Like the rest of deck's HTTP surface, `/metrics` has no authentication of its own: scrape it
over a private network or through the reverse proxy you front deck with.
A minimal scrape job:

```yaml
scrape_configs:
  - job_name: deck
    static_configs:
      - targets: ["deck:8080"]
```
