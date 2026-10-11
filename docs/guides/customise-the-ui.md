# Customise the UI

This guide changes how deck looks and how it is arranged, using config alone. You will rename
and re-theme it, choose the home page, reorder the sidebar and add links to it, and hide or move
the pills, cards, sections and pages the modules add. Everything here goes in the `ui` section
of an overlay layer, and it takes effect without a restart.

It assumes you have an estate config directory (see
[Configure your estate](configure-your-estate.md)). For every key, see the
[`ui` section of the estate configuration reference](../reference/estate-config.md#ui). To add
pages of your own, see [Build a dashboard without code](build-a-dashboard.md).

## Find the ids

Every page, nav entry, pill, card and section in deck has an id of the form
`<kind>:<module>/<name>`, such as `page:inventory/hosts` or `pill:drift/summary`. Config
addresses them by id. `GET /api/ui` lists the ids of everything that is enabled and showing.
Something switched off by its module or by an override is not listed; the defaults are in each
module's manifest (see the [module manifest reference](../reference/module-manifest.md)).
Ask a running deck:

```bash
curl -s localhost:8080/api/ui | jq -r '.pages[].id, .nav[].id, .extensions[].id'
curl -s localhost:8080/api/ui | jq '.extensions[] | {id, slot, order}'
curl -s localhost:8080/api/ui | jq '.navGroups'
```

The built-in modules contribute these:

| What | Ids |
| --- | --- |
| Pages | `page:portal/overview`, `page:inventory/hosts`, `page:inventory/services`, `page:drift/overview`, `page:monitoring/overview`, `page:sources/docs`, `page:sources/configs`, `page:actions/overview`, `page:llm-usage/overview` |
| Detail pages (routed, with path parameters, never in the sidebar and never valid as `home`) | `page:inventory/host-detail` (`/hosts/:name`), `page:inventory/service-detail` (`/services/:host/:name`) |
| Top-bar pills (`app/topbar.status`) | `pill:monitoring/alerts` (order 10), `pill:monitoring/metrics` (20), `pill:llm-usage/summary` (40), `pill:drift/summary`, `pill:portal/endpoints` (100) |
| Top-bar controls (`app/topbar.actions`) | `action:core/theme-menu` |
| Portal summary cards (`portal/summary`) | `card:llm-usage/portal` |
| Host and service sections | `section:drift/host-findings`, `section:drift/service-findings`, `section:sources/host-configs`, `section:sources/service-configs` |

Each page in the sidebar has a nav entry named like it: `nav:drift/overview` for
`page:drift/overview`. Only the modules that are on contribute anything: a module that is off
is listed in `GET /api/ui` under `modules`, with the reason.

## Name and mark it

`brand` sets the name in the sidebar, the browser tab and `index.html`'s title, and the mark
beside it:

```yaml
# my-estate/10-overlay.yaml
ui:
  brand:
    title: Gentry Lab
    icon: house              # an icon name from deck's icon set
    # logoUrl: /logo.svg     # or an image: http(s) URL or a root-relative path
```

Without a `title`, deck uses `estate.name`, then "Deck". The mark is the logo if there is one,
then the icon, then the title's first letter. A logo that fails to load shows the letter.

## Choose a theme

`theme` sets the operator's defaults. It never takes a colour: each preset is a named,
contrast-tested set of deck's tokens.

```yaml
ui:
  theme:
    preset: slate            # teal (default), slate, copper, rose or high-contrast
    mode: dark               # light, dark or system (default)
    density: compact         # comfortable (default) or compact
    radius: sm               # none, sm, md (default) or lg
```

- `preset` changes the accent: links, the focus ring, primary buttons and selection.
  `high-contrast` also strengthens text, controls and edges. Status colours keep their meaning
  in every preset.
- `mode` applies to a viewer who has not picked one in the theme menu. A viewer's own choice
  always wins, and the theme menu chooses only the mode.
- `density: compact` tightens tables, lists, sections and empty states.

## Choose the home page

`/` renders the portal by default. Point `home` at any page without path parameters:

```yaml
ui:
  home: page:inventory/hosts
```

The page keeps its own path too (`/hosts`), and its sidebar entry links to `/`. For a page of
your own as home, see [Customise the portal](build-a-dashboard.md#customise-the-portal). If the
page is unknown, switched off or has parameters, the portal stays home and `GET /api/ui` says why
(`UI_HOME_UNKNOWN`, `UI_HOME_DISABLED`, `UI_HOME_NOT_ROUTABLE`).

## Arrange the sidebar

`nav.groups` orders and relabels the sidebar's groups. The built-in groups are `overview`,
`inventory`, `health`, `operate` and `knowledge`. Groups you do not list follow in that order.

```yaml
ui:
  nav:
    groups:
      - { id: overview }
      - { id: health, label: Monitoring }        # relabel a built-in group
      - { id: lab, label: Lab, icon: monitor }   # a new group
      - { id: inventory }
    items:
      - { id: nav:ui/grafana, group: lab, label: Grafana, href: "https://grafana.example.net", icon: gauge, order: 10 }
      - { id: nav:ui/split, group: lab, separator: true, order: 20 }
      - { id: nav:ui/router, group: lab, label: Router, href: "https://router.example.net", order: 30 }
```

- `items` adds links (`http(s)` URLs, which open in a new tab) and separators. Their ids are
  always `nav:ui/<name>`.
- A group with no entries is not shown, so a new group appears once something is in it.
- Set the group order in the first layer that lists groups. A later layer can relabel a group,
  but cannot move it.

To move a module's entry to another group or position, override it by id (next section):

```yaml
ui:
  extensions:
    nav:actions/overview: { attachTo: { group: lab, order: 50 } }
```

A module's nav entry keeps its own label. To give a page another name in the sidebar, build your
own page instead.

## Hide or move what modules add

`extensions` overrides pages, nav entries, pills, cards and sections by id:

```yaml
ui:
  extensions:
    pill:portal/endpoints: false                          # hide a top-bar pill
    pill:llm-usage/summary: { attachTo: { order: 5 } }    # put a pill first
    card:llm-usage/portal: false                          # hide a portal card
    page:actions/overview: false                          # hide a page and its nav entry
    section:drift/host-findings:                          # rename a host page section
      config: { title: Drift findings, section: findings }
```

- `false` hides it and `true` shows it. Hiding a page also hides its nav entry, and its path
  answers "not found".
- An object can set `enabled`, `attachTo` (`slot`, `order`, and for a nav entry `group`) and,
  for an extension, `config`. A page takes only `enabled`, and a nav entry `enabled` and
  `attachTo`.
- **An override replaces; it never merges.** A new `attachTo` replaces the default as a whole:
  an omitted `slot` or `group` stays as it was, but an omitted `order` becomes 100. A new
  `config` replaces the extension's config entirely, so restate every field it needs. In the
  example, the drift section keeps sharing the `findings` section only because the override
  names it again.
- Hiding a module's UI does not switch the module off: its routes and providers keep running.

An override for an id deck does not know, or one that does not fit what it targets, is ignored
and reported in `GET /api/ui` (`UI_UNKNOWN_EXTENSION`, `UI_INVALID_OVERRIDE`).

## Apply and check

Check the directory before you deploy it:

```bash
deck validate --config ./my-estate
```

A `ui` value of the wrong shape, such as a colour in `theme` or a preset deck does not have, is a
schema error, and deck does not start with it. A `ui` value in the base layer is
`LAYER_OVERLAY_KEY_IN_BASE`, because `ui` belongs to the overlay.

While deck runs, it watches the config directory. A change that touches only `ui` takes effect
without a restart:

- An open page picks up the new layout when its window regains focus, or within a minute.
- `theme` and the home page are written into the page when it loads, so an open page applies a
  change to them on its next load.
- If the edit no longer loads, deck keeps the last good config and the shell shows a notice
  (`UI_CONFIG_INVALID`). Run `deck validate` for the details.
- A change outside `ui` needs a restart; until then the notice says so
  (`UI_RESTART_REQUIRED`).

See what deck made of your config:

```bash
curl -s localhost:8080/api/ui | jq '{brand, home, navGroups, findings}'
```

## Troubleshooting

| You see | Cause | Fix |
| --- | --- | --- |
| A change has no effect | The page has not refetched yet, or the change was to `theme` or `home`. | Focus the window, or reload the page. |
| The portal is still home | `home` names an unknown, hidden or parameterised page. | Read the `UI_HOME_*` finding in `GET /api/ui`. |
| An override is ignored | The id is misspelt, or the override does not fit its target (`config` on a page). | Copy the id from `GET /api/ui`; read the `UI_*` finding. |
| A moved pill jumped to the end | Its `attachTo` has no `order`, which then becomes 100. | Give the override an `order`. |
| A section lost its heading or merged | Its `config` override dropped `title` or `section`. | Restate the whole `config`. |
| A notice says the config is invalid | The last edit does not validate. | Run `deck validate` and fix the finding. |
| A notice says a restart is required | Something outside `ui` changed. | Restart deck. |

## See also

- [Estate configuration reference: `ui`](../reference/estate-config.md#ui)
- [Build a dashboard without code](build-a-dashboard.md)
- [HTTP API reference: UI manifest](../reference/http-api.md#ui-manifest)
- [ADR-006: Config-driven UI as one extension tree](../architecture/decisions/adr-006-config-driven-ui.md)
