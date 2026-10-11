# Widget types reference

A widget type is what a dashboard widget renders: the `type` of a widget in a `ui.pages` page,
in a module page's default layout, or in a sidecar's describe document. deck provides the
generic `core/…` types itself; modules add their own through `contributes.widgetTypes`
([module manifest](module-manifest.md#widgettypes)). `GET /api/ui` lists the types available in
a running deck under `widgetTypes`, each with the module that provides it.

The widget's own keys (`id`, `title`, `source`, `select`, `span`, `rows`) and the `select`
limits are in the [estate configuration reference](estate-config.md#ui). A widget type
declares the schema of its `options`, and `deck validate` and boot check every widget's
`options` against it: an unknown option, or a value of the wrong type, is a schema error at its
path. Omitted `options` are checked as `{}`, so a type that needs an option needs `options`.

## Deck's own types

Deck's own widget types show the widget's value: its `select` result, or the provider's data
whole. Each shows what it got when the value is of a kind it cannot show ("core/stat shows a
number or text; this widget's value is a list."), so a wrong `select` is easy to spot.

| Type | Shows | Options |
| --- | --- | --- |
| `core/stat` | One number or short text, large. | `label`, `format`, `unit`, `statusMap` |
| `core/stat-grid` | Values of an object, each a stat. | `items`: `{field, label?, format?, unit?, statusMap?}`, 1–24; default the object's numbers, text and booleans, by key (the first 24) |
| `core/meter` | A number against a maximum, as a bar with its value as text. | `label`, `max` (default 100), `format` (default: the percentage of `max`), `unit`, `statusMap` |
| `core/key-value` | An object's values as label/value pairs; a value with a `statusMap` as a status badge. | `items` as for `core/stat-grid`, 1–48 (default the object's keys, the first 48); `layout`: `grid` (default), `stacked`, `inline` |
| `core/list` | A list's items as rows. An item that is text or a number is its own title. | `titleField` (default `name`), `descriptionField`, `metaField`, `metaFormat`, `statusField` and `statusMap` (a status badge), `hrefField` (a link), `limit` (1–100, default 25) |
| `core/table` | A list of objects as a table; the first column's cells are row headers. | `columns` (required, 1–12): `{field, header?, format?, unit?, align?: start\|end, statusMap?}`; `limit` (1–500, default 100) |
| `core/status-grid` | Named states as tiles, each with a status badge. The value is a list of objects, or an object of name → state. | `labelField` (default `name`), `statusField` (default `status`), `hrefField`, `statusMap`, `limit` (1–200, default 48) |
| `core/link-tiles` | Links as tiles. | `links`: `{title, href, description?, icon?}`, 1–48; without it, the value, a list of objects with those keys |
| `core/markdown` | Markdown, rendered and sanitised as the docs view does it. | `content`; without it, the value, which must be text |
| `core/embed` | Another site's page in a sandboxed frame, with a link that opens it in a new tab. Reads no source. Needs `ui.allowUnsafeEmbeds: true` ([below](#coreembed)). | `url` (required): an absolute `http(s)` URL; `height`: `sm`, `md` (default), `lg` or `xl` (15, 24, 36 or 48 rem); `sandbox`: what the page may do ([below](#coreembed)) |
| `core/health-pills` | The top bar's health pills, in its order. Reads no source. | `pills`: extension ids (`pill:drift/summary`) to show only those |
| `core/json` | The value as formatted JSON, for looking at what a source and `select` give. | `wrap: true` soft-wraps long lines |

## Module types

The portal module adds one type:

| Type | Shows | Options |
| --- | --- | --- |
| `portal/groups` | The portal's groups of cards, with its search and its status and group filters. Reads no source: it reads `modules.portal.groups` and the cards' providers. | `groups`: the top-level group ids to show, in that order (1–64, unique); default every group, in the portal's order. An id no group has is skipped and reported in `GET /api/ui` (`UI_WIDGET_OPTION_UNKNOWN`). |

A module, built in or runtime, adds a type with a `contributes.widgetTypes` entry: its
`type` (`<module>/<name>`), its options schema, the component that renders it, and optionally
the provider kinds it can render (`sources`). A widget of a type no module provides is
`UI_WIDGET_TYPE_UNKNOWN`, and one whose module is off is `UI_WIDGET_TYPE_DISABLED`; either
shows as unavailable and reads no data. A widget over a provider of a kind its type does not
list in `sources` is `UI_WIDGET_SOURCE_KIND`.

## Fields, formats, links and status maps

- A **field** (`field`, `titleField`, …) is a key of an item, or keys joined by dots
  (`load.avg`). It is never a query: shape the data with the widget's `select`, such as
  `outlets[].{name: name, watts: power.watts}`.
- A **format** is one of `text` (as given, the default), `number` (grouped digits, at most two
  decimals), `bytes` (1024-based: `1.5 GiB`), `percent` (a number of 100: `42.3%`), `duration`
  (seconds: `1h 31m`) and `relative-time` (an ISO time or epoch milliseconds: `6m ago`). A value
  the format cannot read shows as given. `unit` follows the value (`61.5 W`).
- A **link** (`hrefField`, `links[].href`) is an `http(s)` URL, which opens in a new tab, or an
  absolute path in deck (`/hosts/nas-01`). A value from data that is neither is shown unlinked.
- A **`statusMap`** names one of the config's [`ui.statusMaps`](estate-config.md#ui): exact `values` and ordered `rules` mapping a value to a tone. A toned value shows the tone's icon and the value's own text, never colour alone.

## core/embed

`core/embed` frames another site's page, so it is opt-in: a `core/embed` widget while
`ui.allowUnsafeEmbeds` is not `true` frames nothing and shows "Embeds are off", and `deck
validate` notes it as `UI_EMBED_DISALLOWED` (info). The gate is checked on the merged document,
so it may sit in another layer than the widget, and turning it off takes effect on hot reload.
With it on:

- The frame always has a `sandbox`. By default it is `allow-scripts allow-same-origin`: the page
  runs its own scripts as its own origin. `sandbox` replaces that list with tokens from
  `allow-scripts`, `allow-same-origin`, `allow-forms`, `allow-popups`,
  `allow-popups-to-escape-sandbox` and `allow-downloads`; `[]` allows nothing. Top navigation,
  modals and the other sandbox tokens are never granted. `allow-popups-to-escape-sandbox` makes
  the framed page's popups ordinary, unsandboxed top-level windows whose opener chain reaches
  deck's own tab, outside the sandbox; avoid it.
- `url` must be an absolute `http(s)` URL that the URL parser accepts, with a non-empty host
  and no `user:password@`. The parser refuses an invalid IPv4 or IPv6 host and a port past
  65535, for example. The schema checks only the loose shape (`http(s)://`, then an authority
  without `@`, whitespace or backslashes). `deck validate` then reports a URL the parser refuses
  as `UI_EMBED_URL_INVALID` (an error), and the browser runs the same check before it frames
  anything. While embeds are on, a valid URL whose origin deck's Content-Security-Policy cannot
  name (an IPv6 literal, a host with `_`) is `UI_EMBED_NOT_FRAMEABLE` (a warning): the widget says
  it can't be embedded.
- The frame sends no referrer, loads lazily and is titled by the widget's `title` (default "Page
  from" its host).
- A URL on deck's own origin is refused in the browser ("Deck does not frame its own pages"),
  since such a page could lift its own sandbox. Where the framed site redirects or navigates
  afterwards is held by the page's Content-Security-Policy: only the embeds' origins and
  `ui.frameSources`, never deck's own (see [Security](../security.md#browser-policy)).
- A site that refuses to be framed (`X-Frame-Options`, CSP `frame-ancestors`) leaves the frame
  blank; the link under it opens the page in a new tab.

## What a sidecar may use

A sidecar's describe document ([remote provider protocol](remote-provider-protocol.md)) places
widgets, but it cannot add types, and it may use only deck's declarative ones:

| Allowed | Never allowed |
| --- | --- |
| `core/stat`, `core/stat-grid`, `core/meter`, `core/key-value`, `core/list`, `core/table`, `core/status-grid`, `core/link-tiles`, `core/markdown`, `core/json` | `core/embed` (whatever `ui.allowUnsafeEmbeds` says), `core/health-pills`, and every module's types |

Each of its widgets reads only its own integration's data, and its markdown may link only to
absolute `http(s)` URLs.

## What a widget's component receives

A widget type's component, in its module's web half, receives `WidgetProps`:

| Prop | What it is |
| --- | --- |
| `value` | The widget's `select` result, which the server evaluated into the provider's envelope (`projections`), or the provider's data whole; `null` for a widget without a source. |
| `options` | The widget's options, already checked against the type's options schema. |
| `freshness` | The provider envelope's freshness stamp, or `null`. |
| `widget` | The placed widget as `GET /api/ui` lists it. |
| `placement` | Where it renders: `card` (a dashboard card, the default) or `page` (a module page's own content, as the portal's groups). |

The shell renders the loading, empty, error and freshness states around the component, so a
component only renders a value it can show. Given a value of a kind it cannot show, deck's own
types say so; a module's type should do the same. See
[Web UI: Config pages and widget types](../architecture/ui.md#config-pages-and-widget-types).

## See also

- [Build a dashboard without code](../guides/build-a-dashboard.md)
- [Estate configuration reference: `ui`](estate-config.md#ui): pages, sections, widgets,
  `statusMaps` and the `select` limits.
- [Module manifest reference: widgetTypes](module-manifest.md#widgettypes)
- [Security: browser policy](../security.md#browser-policy)
