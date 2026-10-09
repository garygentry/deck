# Build a dashboard without code

This guide builds a dashboard page from config alone. An `http-json` integration polls any JSON
API, and deck's generic widgets show the parts of the response you pick, toned by status maps
you declare. There is no module to write and no container to add.

It assumes you have an estate config directory (see
[Configure your estate](configure-your-estate.md)) and are comfortable with YAML.
For every key, see the [`ui` section of the estate configuration reference](../reference/estate-config.md#ui).

A finished example is in [`examples/dashboard/20-dashboard.yaml`](../../examples/dashboard/20-dashboard.yaml):
a page built over deck's own `/api/health`. [Try the example](#try-the-example) shows how to
run it.

## Add a data source

Declare the API as an integration of kind `http-json` in an overlay layer, such as
`10-overlay.yaml`. deck polls the URL on a schedule, parses the JSON and serves it as a
provider, `GET /api/providers/<id>`. Your browser never calls the API itself.

```yaml
schemaVersion: 2
integrations:
  - id: ups
    kind: http-json
    title: UPS
    url: http://nut-exporter.home.example:9199/status.json
    pollIntervalMs: 15000
```

If the API needs a credential, name the environment variable that holds it with
`credentialEnv`, and say how to send it with `auth`. The config never holds the secret.

```yaml
    credentialEnv: UPS_TOKEN
    auth: { scheme: bearer }   # or basic, header (with header: X-Api-Key), or query
```

Integrations are not part of `ui`, so **restart deck** after adding or changing one. The
[http-json reference](../reference/provider-kinds.md#http-json) covers methods, timeouts,
redirects and how failures show.

Check that deck can read it:

```bash
curl -s http://localhost:8080/api/providers/ups | jq '.data'
```

This guide uses this response from the UPS API:

```json
{
  "model": "Eaton 5P", "load_pct": 72, "battery_pct": 18, "runtime_s": 5460,
  "outlets": [
    { "name": "nas-01", "watts": 61.5, "state": "on" },
    { "name": "printer", "watts": 0, "state": "fault" }
  ]
}
```

## Add a page

A config page lives under `ui.pages`. It has an `id`, a `path`, a `title` (its one heading)
and sections of widgets. With `nav`, it also gets a sidebar entry.

```yaml
ui:
  nav:
    groups:
      - { id: lab, label: Lab, icon: boxes }   # a new sidebar group
  pages:
    - id: power
      path: /power
      title: Power
      icon: gauge
      nav: { group: lab, order: 0 }
      sections:
        - title: UPS
          columns: 3
          widgets:
            - { id: raw, type: core/json, title: Raw data, source: ups }
```

- A section is a heading over a grid of 1–4 `columns`. A widget's `span` (1–4) takes more
  than one column. Below the `md` breakpoint every section is one column. Widgets read in the
  order you list them.
- Give every widget an `id`. Its full id is `widget:ui/<page>.<id>`, which is how you hide or
  replace it later. Without one, its id is positional and changes when widgets move.
- `core/json` shows a widget's value as formatted JSON. Start with it to see what a source
  gives you, then swap in the widget you want.

The page is at `/power`, and its sidebar entry is under **Lab**.

## Pick values with select

A widget shows its `select` result: a [JMESPath](https://jmespath.org) expression that deck
evaluates **on the server** each time the provider's data changes. Without `select`, a widget
gets the whole response.

| You want | `select` | Widget |
| --- | --- | --- |
| One number | `load_pct` | `core/stat`, `core/meter` |
| Some fields of an object | `{load: load_pct, runtime: runtime_s}` | `core/stat-grid`, `core/key-value` |
| A list of rows | `outlets` | `core/table`, `core/list`, `core/status-grid` |
| Only some rows | `outlets[?state != 'on']` | the same |
| A count | `length(outlets[?state == 'fault'])` | `core/stat` |

```yaml
          widgets:
            - { id: load, type: core/stat, title: Load, source: ups, select: load_pct, options: { format: percent } }
            - { id: battery, type: core/meter, title: Battery, source: ups, select: battery_pct, options: { label: Charge } }
            - { id: runtime, type: core/stat, title: Runtime, source: ups, select: runtime_s, options: { format: duration } }
            - id: outlets
              type: core/table
              title: Outlets
              source: ups
              select: outlets
              span: 3
              options:
                columns:
                  - { field: name, header: Outlet }
                  - { field: watts, header: Draw, format: number, unit: W, align: end }
                  - { field: state, header: State }
```

Options shape how the value reads: `format` (`number`, `bytes`, `percent`, `duration`,
`relative-time`), `unit`, labels, and the columns or fields to show. A field (`field`,
`titleField`, …) is a key or dotted keys (`power.watts`), never a query: shape the data in
`select`. The [widget table](../reference/estate-config.md#ui) lists every type and option.

If a widget gets a value it cannot show, it says so (`core/stat shows a number or text; this
widget's value is a list.`), so a wrong `select` is easy to spot.

## Colour values by meaning

Config never names a colour. A **status map** gives a value a tone (`ok`, `warn`, `danger`,
`info`, `pending` or `neutral`), and the widget shows the tone's icon beside the value's own
text. Declare maps under `ui.statusMaps` and name one in a widget's `statusMap` option.

```yaml
ui:
  statusMaps:
    ups-load: { rules: [ { lt: 60, tone: ok }, { lt: 85, tone: warn }, { tone: danger } ] }
    outlet:   { values: { on: ok, off: neutral, fault: danger } }
  pages:
    - id: power
      # …
          widgets:
            - { id: load, type: core/stat, title: Load, source: ups, select: load_pct, options: { format: percent, statusMap: ups-load } }
            - id: outlets
              # …
              options:
                columns:
                  - { field: name, header: Outlet }
                  - { field: state, header: State, statusMap: outlet }
```

`values` matches exact values; `rules` are tried in order, and a rule with only a `tone`
matches anything, so put it last.

## Check it and see it

Validate the directory before deploying:

```bash
deck validate --config ./my-estate
```

A widget option its type does not accept, a `select` that is not JMESPath, a widget type no
module provides, or a status map that is not declared is a finding at its path. deck does not
start with any of them.

Changes inside `ui` take effect **without a restart**: deck watches the config directory and
swaps the page in. An open page picks the change up when its window regains focus, or within a
minute. If the edit is invalid, deck keeps the last good config and the shell shows a notice.
Run `deck validate` for the details.

## Embed another site's page

`core/embed` shows another site's page in a frame, such as a Grafana panel or a router's
status page. It is **off unless you opt in**, because a framed page is someone else's code
running inside deck's page:

```yaml
ui:
  allowUnsafeEmbeds: true
  pages:
    - id: power
      # …
          widgets:
            - id: graph
              type: core/embed
              title: UPS load, last 24 hours
              span: 3
              options:
                url: https://grafana.home.example/d-solo/ups?panelId=2&theme=dark
                height: lg            # sm, md (default), lg or xl
```

- Without `allowUnsafeEmbeds: true`, a `core/embed` widget is `UI_EMBED_DISALLOWED` and deck
  does not start.
- The frame is always sandboxed. By default the framed page may run its own scripts as its own
  origin (`allow-scripts allow-same-origin`), which most dashboards need. Set `sandbox` to
  replace that list: `sandbox: []` allows nothing. You can add `allow-forms`, `allow-popups`,
  `allow-popups-to-escape-sandbox` and `allow-downloads`. A framed page can never navigate
  deck's tab or open dialogs over it.
- The frame sends no referrer and loads when it scrolls into view. Its title is the widget's
  `title`, so give every embed one.
- The URL must be an absolute `http(s)` URL on another origin than deck's. deck does not frame
  its own pages; put their widgets on a dashboard instead.
- Many sites refuse to be framed (`X-Frame-Options` or a CSP `frame-ancestors`), and the frame
  then stays blank. Allow deck's origin in that site's settings (Grafana: `allow_embedding`),
  or use the **Open** link under the frame, which opens the page in a new tab.

Only embed sites you trust. The sandbox keeps a framed page away from deck, but the page still
runs in each viewer's browser, with that browser's cookies for its own site, and shows them
whatever it likes.

## Customise the portal

The portal (`page:portal/overview`, at `/portal` and by default at `/`) is a dashboard too.
Its groups of cards are one `portal/groups` widget. To change what `/` shows, build your own
page with that widget beside any others, and make it the home page:

```yaml
ui:
  home: page:ui/start
  pages:
    - id: start
      path: /start
      title: Home lab
      nav: { group: overview, label: Start, order: -2 }
      sections:
        - title: At a glance
          columns: 3
          widgets:
            - { id: load, type: core/stat, title: UPS load, source: ups, select: load_pct, options: { format: percent, statusMap: ups-load } }
            - { id: health, type: core/health-pills, title: Health, span: 2 }
        - title: Services
          widgets:
            - { id: apps, type: portal/groups, title: Everyday, options: { groups: [overview] } }
        - title: Infrastructure
          widgets:
            - { id: infra, type: portal/groups, title: Infrastructure, options: { groups: [infrastructure] } }
  extensions:
    page:portal/overview: false   # optional: hide the built-in portal page and its nav entry
```

- `portal/groups` shows the portal's cards, with its search and its status and group filters.
  It reads `modules.portal.groups` itself, so it takes no `source`.
- `groups` lists the top-level group ids (`modules.portal.groups[].id`) to show, in that order.
  Without it, the widget shows every group. An id that no group has is skipped, and
  `GET /api/ui` reports it (`UI_WIDGET_OPTION_UNKNOWN`).
- `home` takes any page without path parameters. The page also stays at its own path, here
  `/start`.
- To keep the built-in portal and change only part of it, hide pieces by id instead. For
  example, `widget:portal/overview.groups: false` hides its groups, and `pill:portal/endpoints:
  false` hides its top-bar pill. `GET /api/ui` lists every id.

## Try the example

[`examples/dashboard/20-dashboard.yaml`](../../examples/dashboard/20-dashboard.yaml) is an
overlay layer that adds an **Estate pulse** page under a **Lab** group. It reads deck's own
`/api/health` through `http-json`, so it needs no other service. Copy it beside the example
estate's layers and start deck:

```bash
cp examples/dashboard/20-dashboard.yaml examples/estate/
cd examples && docker compose up --build
# open http://localhost:8080/pulse
```

The integration's URL is the address deck listens on (`8080` in the compose example). Under
`pnpm dev` the API listens on `8788`, so change the port there. Remove the file to take the
page away again.

## Troubleshooting

| You see | Cause | Fix |
| --- | --- | --- |
| Widget unavailable | The module that provides its `type` is off (`UI_WIDGET_TYPE_DISABLED`). | Enable the module, or remove the widget. |
| No data source | `source` names no provider (`UI_WIDGET_SOURCE_UNKNOWN` in `GET /api/ui`). | Use an id from `GET /api/providers`; restart after adding an integration. |
| Data source unavailable | The provider has no data because the API failed. | Read the error in the widget's details, or `curl` the provider. |
| Select failed | The `select` failed on this data or hit a size limit. | Try the expression on the `core/json` widget's value. |
| Unexpected data | The value is the wrong kind for the widget. | Change `select` (a list for a table, a number for a stat). |
| Values without a tone | No entry or rule of the status map matched. | Add a value or a catch-all rule. |
| A blank embed | The site refuses to be framed. | Allow deck's origin there, or use the Open link. |

## See also

- [Estate configuration reference: `ui`](../reference/estate-config.md#ui): every page,
  widget and status map key, and the `select` limits.
- [Provider kinds: http-json](../reference/provider-kinds.md#http-json): polling, auth and
  failure handling.
- [HTTP API](../reference/http-api.md): `GET /api/ui` and provider envelopes.
