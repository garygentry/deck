# Write a sidecar module

A sidecar is a small HTTP service, in any language, that brings data deck has no kind for and
says how to show it. Deck polls it, renders the widgets it describes with deck's own widget
types, and gives it a page. The sidecar runs outside deck's process and holds no UI code, so a
bug or a crash in it cannot take deck down.

Write a sidecar when the data needs code:

- a protocol that is not JSON over HTTP (NUT, SNMP, a serial device, a CLI);
- a credential you would rather deck never held;
- logic you would rather keep out of deck, or write in another language.

If the data is already JSON over HTTP, you need no code at all: see
[Build a dashboard without code](build-a-dashboard.md). This guide builds a sidecar that reports
the free space of a few disks. The protocol itself is in the
[remote provider protocol reference](../reference/remote-provider-protocol.md).

## Serve the data

Deck polls `GET /deck/v1/data` and expects `200` with a JSON body:

```json
{ "data": { "fullest_pct": 71.4, "disks": [ { "path": "/", "used_pct": 71.4, "free": 30064771072 } ] },
  "observedAt": "2026-10-09T09:00:00Z" }
```

- `data` is any JSON. It is what the widgets read, and what their `select` expressions shape.
- `observedAt` (optional, RFC 3339) is when the sidecar took the reading. Deck judges staleness
  from it rather than from the poll time, so a sidecar that relays old data shows as stale.

Answer an error status when you cannot read the data. Deck keeps the last good data, marks the
provider unhealthy, and the page's widgets show the problem.

## Describe the widgets

Deck asks `GET /deck/v1/describe` what to show. It asks with the first poll, then every five
minutes by default (`describeIntervalMs`), and backs off after a failure:

```json
{
  "deck": 1,
  "id": "disks",
  "version": "1.0.0",
  "title": "Disks",
  "columns": 2,
  "widgets": [
    { "id": "fullest", "type": "core/meter", "title": "Fullest disk", "select": "fullest_pct", "options": { "max": 100, "unit": "%" } },
    { "id": "disks", "type": "core/table", "title": "Disks", "select": "disks", "span": 2,
      "options": { "columns": [ { "field": "path", "header": "Path" },
                                { "field": "used_pct", "header": "Used", "format": "percent", "align": "end" },
                                { "field": "free", "header": "Free", "format": "bytes", "align": "end" } ] } }
  ],
  "links": [ { "title": "Runbook", "href": "https://wiki.example.net/disks" } ]
}
```

- `id` should be the `id` of the integration that points at the sidecar (below). Deck always
  uses the integration's.
- A widget is a dashboard widget **without `source`**: it reads this sidecar's data. Give each
  one an `id`. Its `select` and `options` follow the
  [widget types reference](../reference/widget-types.md).
- Only deck's declarative types are allowed: `core/stat`, `core/stat-grid`, `core/meter`,
  `core/key-value`, `core/list`, `core/table`, `core/status-grid`, `core/link-tiles`,
  `core/markdown` and `core/json`. A sidecar cannot frame a page (`core/embed`) or use a
  module's widget types.
- `links` become tiles under the widgets, and `nav` entries become sidebar links beside the
  sidecar's page. Every link is an `http(s)` URL or a path in deck. Markdown may link only to
  `http(s)` URLs.

Deck checks the whole document and refuses all of it if any part is wrong. Until one succeeds,
the page shows a placeholder. After that, the last good describe keeps rendering.

## Write it

This sidecar uses only Python's standard library. It reads the paths in `DISK_PATHS`, and with
`SIDECAR_TOKEN` set it requires that token on both endpoints:

```python
"""A deck sidecar (remote provider protocol v1): free space of the paths in $DISK_PATHS."""
import datetime, hmac, json, os, shutil
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PATHS = [path for path in os.environ.get("DISK_PATHS", "/").split(",") if path]
TOKEN = os.environ.get("SIDECAR_TOKEN", "")
DESCRIBE = {
    "deck": 1, "id": os.environ.get("SIDECAR_ID", "disks"), "version": "1.0.0", "title": "Disks", "columns": 2,
    "widgets": [
        {"id": "fullest", "type": "core/meter", "title": "Fullest disk", "select": "fullest_pct",
         "options": {"max": 100, "unit": "%"}},
        {"id": "disks", "type": "core/table", "title": "Disks", "select": "disks", "span": 2,
         "options": {"columns": [{"field": "path", "header": "Path"},
                                 {"field": "used_pct", "header": "Used", "format": "percent", "align": "end"},
                                 {"field": "free", "header": "Free", "format": "bytes", "align": "end"}]}},
    ],
    "links": [{"title": "Runbook", "href": "https://wiki.example.net/disks"}],
}

def read_disks():
    disks = []
    for path in PATHS:
        usage = shutil.disk_usage(path)
        disks.append({"path": path, "used_pct": round(100 * usage.used / usage.total, 1), "free": usage.free})
    return {"fullest_pct": max(disk["used_pct"] for disk in disks), "disks": disks}

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if TOKEN and not hmac.compare_digest(self.headers.get("Authorization", ""), f"Bearer {TOKEN}"):
            return self.reply(401, {"error": "unauthorised"})
        if self.path == "/deck/v1/describe":
            return self.reply(200, DESCRIBE)
        if self.path != "/deck/v1/data":
            return self.reply(404, {"error": "not found"})
        try:
            data = read_disks()
        except (OSError, ValueError):
            return self.reply(502, {"error": "cannot read the disks"})
        now = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        self.reply(200, {"data": data, "observedAt": now})

    def reply(self, status, body):
        payload = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

if __name__ == "__main__":
    server = ThreadingHTTPServer((os.environ.get("BIND", "0.0.0.0"), int(os.environ.get("PORT", "9000"))), Handler)
    server.serve_forever()
```

Try it on its own before pointing deck at it:

```bash
DISK_PATHS=/,/tmp PORT=9000 python3 -I disks.py &
curl -s localhost:9000/deck/v1/data | jq .
curl -s localhost:9000/deck/v1/describe | jq '.widgets[].id'
```

A fuller example is [`examples/sidecars/nut-ups/`](../../examples/sidecars/nut-ups/), which
reads a UPS through NUT and ships a Compose snippet.

## Run it beside deck

Run the sidecar where deck can reach it, and nowhere else: on deck's Compose network, with no
published port. Give both containers the same token, from your environment or a secrets store:

```yaml
# compose.override.yaml, beside deck's compose.yaml
services:
  disks:
    image: python:3.12-alpine
    command: ["python3", "-I", "/app/disks.py"]
    volumes:
      - ./disks.py:/app/disks.py:ro
      - /srv:/srv:ro                 # what it measures
    environment:
      DISK_PATHS: /srv
      SIDECAR_TOKEN: ${DISKS_SIDECAR_TOKEN:?set DISKS_SIDECAR_TOKEN}
    read_only: true
    user: nobody
    restart: unless-stopped
  deck:
    environment:
      DISKS_SIDECAR_TOKEN: ${DISKS_SIDECAR_TOKEN:?set DISKS_SIDECAR_TOKEN}
```

The token must be at least 8 characters, with no leading or trailing whitespace.

## Point deck at it

Add a `remote` integration to an overlay layer. Its `id` is the provider id and names the
page:

```yaml
integrations:
  - id: disks
    kind: remote
    title: Disks
    url: http://disks:9000
    credentialEnv: DISKS_SIDECAR_TOKEN   # the variable's name, never its value
    auth: { scheme: bearer }
    pollIntervalMs: 60000
    page:
      path: /disks                       # default /remote/disks
      icon: server
      nav: { group: health }             # a sidebar entry under Health
```

Check the config with `deck validate`, then restart deck: a new integration is not picked up by
hot reload. The page is `page:remote/disks` at `/disks`, and each widget is
`widget:remote/disks.<widget id>`, so the [`ui` config](customise-the-ui.md) can hide or move
them like any other. The sidecar's data is also an ordinary provider: a `ui.pages` dashboard can
read it with `source: disks`.

## Check that it works

```bash
curl -s localhost:8080/api/providers/disks | jq '{data, error, freshness}'
curl -s localhost:8080/api/health | jq '.providers.disks'
curl -s localhost:8080/api/ui | jq '.findings[] | select(.code | startswith("REMOTE_"))'
```

Then open `/disks`. The health detail names both requests, such as
`data: HTTP 200, observed 2026-10-09T09:00:00.000Z; describe: ok (disks 1.0.0)`.

| You see | Cause | Fix |
| --- | --- | --- |
| The page says it has not been described yet | No describe has succeeded since deck started. | Wait for the first poll, then check the sidecar is reachable from deck's network. |
| `REMOTE_DESCRIBE_UNREACHABLE` | Deck could not fetch the describe (connection, timeout, status). | `curl` the describe from inside deck's network, with the token. |
| `REMOTE_DESCRIBE_INVALID` | The describe broke a rule: a type outside the allowlist, a widget with a `source`, an option its type refuses, a `select` too large, a link deck refuses. | Run the document past [`remote-describe.schema.json`](../../packages/schema/schema/remote-describe.schema.json) and the rules in the [protocol reference](../reference/remote-provider-protocol.md). |
| `REMOTE_DESCRIBE_ID_MISMATCH` | The describe's `id` is not the integration's. | Set the sidecar's id to the integration's (`SIDECAR_ID` above). |
| `REMOTE_NAV_UNPLACED` | The describe has `nav` entries but the page has no `page.nav`. | Give the integration a `page.nav`. |
| The provider's error says the credential is not set | Deck's environment lacks the variable `credentialEnv` names, or it is under 8 characters. | Set it where deck runs. |
| `upstream answered HTTP 401` | The tokens differ. | Give both containers the same value. |
| A widget says "Select failed" | Its `select` does not fit the data. | Look at the data with a `core/json` widget, then fix the `select`. |

## See also

- [Remote provider protocol reference](../reference/remote-provider-protocol.md)
- [Widget types reference](../reference/widget-types.md)
- [Kernel and modules: choosing how to extend deck](../explanation/kernel-and-modules.md#choosing-how-to-extend-deck)
- [Security: trust tiers](../security.md#trust-tiers)
