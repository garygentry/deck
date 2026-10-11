# NUT UPS sidecar

A deck remote provider in about 50 lines of Python (standard library only). It reads a UPS
through [NUT](https://networkupstools.org/)'s `upsc` and speaks deck's
[remote provider protocol](../../../docs/reference/remote-provider-protocol.md):

- `GET /deck/v1/describe`: a status and runtime stat, load and battery meters, a details
  panel and a documentation link;
- `GET /deck/v1/data`: `{ "data": { "status", "load", "charge", "runtime", "inputVoltage", "model" }, "observedAt" }`.

Use it as a template for any sidecar: deck renders the widgets, so the sidecar holds no UI code.

## Run it

| Variable | Default | Meaning |
|---|---|---|
| `NUT_UPS` | `ups@localhost` | The UPS `upsc` asks, as `<name>@<host>[:port]`. |
| `PORT` | `9000` | The port it listens on. |
| `BIND` | `0.0.0.0` | The address it listens on. |
| `SIDECAR_TOKEN` | unset | When set, both endpoints require `Authorization: Bearer <token>`. |
| `SIDECAR_ID` | `ups` | The `id` its describe reports: set it to the integration's id. |

With Docker Compose, run it beside the example deck from `examples/`:

```sh
cd examples
UPS_SIDECAR_TOKEN=<8+ characters> docker compose -f compose.yaml -f sidecars/nut-ups/compose.yaml up --build
```

Compose resolves the snippet's paths against `examples/`, the first file's directory. Without
Compose, run `python3 -I nut_ups.py` on a machine with `upsc` installed.

## Point deck at it

Add a `remote` integration to your estate overlay. Deck reads the token from the environment
variable `credentialEnv` names; config never holds it.

```yaml
integrations:
  - id: ups
    kind: remote
    title: UPS
    url: http://nut-ups:9000
    credentialEnv: UPS_SIDECAR_TOKEN
    auth: { scheme: bearer }
    pollIntervalMs: 15000
    page:
      path: /power/ups          # default /remote/ups
      icon: zap
      nav: { group: health }    # a sidebar entry under Health
```

The UPS page shows the sidecar's widgets once it has described itself. Its health appears under
`/api/health` as provider `ups`.
