# Remote provider protocol (v1)

A **remote provider** (a sidecar) is a small HTTP service, in any language, that deck polls for
data and asks what to show. It suits anything deck has no kind for that needs code: a protocol
that is not JSON over HTTP (NUT, SNMP, a serial device), credentials deck should not hold, or
logic you would rather keep out of deck. The sidecar holds no UI code. It describes widgets,
links and nav entries, and deck renders them with its own widget types, so a sidecar can never
run code in the browser.

A working example is [`examples/sidecars/nut-ups/`](../../examples/sidecars/nut-ups/): a NUT UPS
adapter in about 50 lines of standard-library Python, with a compose snippet.

## Configure it in deck

Each sidecar is an `integrations[]` entry of kind `remote`, registered as a provider under its
`id`:

```yaml
integrations:
  - id: ups
    kind: remote
    title: UPS
    url: http://nut-ups:9000          # the sidecar's base URL
    credentialEnv: UPS_SIDECAR_TOKEN   # optional; the variable's name, never its value
    auth: { scheme: bearer }
    pollIntervalMs: 15000
    page:
      path: /power/ups                 # default /remote/<id>
      icon: zap
      nav: { group: health }           # a sidebar entry; without it the page has none
```

| Key | Required | Notes |
| --- | --- | --- |
| `id` | yes | Lowercase letters, digits and `-`, at most 64 characters. The provider id (`GET /api/providers/<id>`) and the name of its page (`page:remote/<id>`). Taking the fixed provider id of another integration in the estate is `REMOTE_ID_RESERVED`. |
| `title` | yes | The page title, and its heading until the sidecar gives one. |
| `url` | yes | The sidecar's `http://` or `https://` base URL, with no query, fragment or `user:password@`. Deck requests `/deck/v1/describe` and `/deck/v1/data` under it. A URL the runtime cannot parse is `REMOTE_URL_INVALID`. |
| `credentialEnv`, `auth` | no | As for [`http-json`](provider-kinds.md#http-json): the credential comes only from the named variable, and is sent on both requests. |
| `pollIntervalMs`, `ttlMs`, `timeoutMs`, `maxBytes` | no | As for `http-json`; they govern the data request. `timeoutMs` bounds the describe request too, separately. |
| `describeIntervalMs` | no | Milliseconds between describe requests once one succeeded, 10000–86400000; default 300000. |
| `page` | no | `path` (literal segments; default `/remote/<id>`), `icon` and `nav` (`{ group, label?, order? }`), as a `ui.pages` page takes them. |
| `deepLink` | no | A link to the sidecar's own UI. |

## Endpoints

Both are `GET`, answer `200` with a JSON body, and receive the credential when one is configured.
Every request goes through the same hardening as `http-json`: the response size cap (1 MiB for
data by default, 256 KiB for describe), a 64-level nesting limit, no redirect off the
configured origin for an authenticated request, and refusal of any response that contains the
credential.

### `GET /deck/v1/data`

```json
{ "data": { "load": 23, "status": "OL" }, "observedAt": "2026-10-09T09:00:00Z" }
```

`data` (any JSON) is the provider's data: what widgets read and their `select` shapes. The
optional `observedAt` (RFC 3339, at most 40 characters) is when the sidecar took it: the
envelope's `observedAt` and age, and so its staleness, follow it rather than the poll time (a
time in the future counts as now), and the health detail shows it normalised. A body without
`data`, or with a malformed `observedAt`, fails the poll.

### `GET /deck/v1/describe`

```json
{
  "deck": 1,
  "id": "ups",
  "version": "1.0.0",
  "title": "UPS",
  "columns": 2,
  "widgets": [
    { "id": "load", "type": "core/meter", "title": "Load", "select": "load", "options": { "max": 100, "unit": "%" } },
    { "id": "status", "type": "core/stat", "title": "Status", "select": "status" }
  ],
  "links": [{ "title": "NUT documentation", "href": "https://networkupstools.org/" }],
  "nav": [{ "id": "nut", "label": "NUT web UI", "href": "https://nut.example/" }]
}
```

Its JSON Schema is [`packages/schema/schema/remote-describe.schema.json`](../../packages/schema/schema/remote-describe.schema.json),
built from the estate config schema's own descriptors:

| Key | Notes |
| --- | --- |
| `deck` | `1`, the protocol version. |
| `id` | The sidecar's id. When it differs from the integration's `id`, deck uses the integration's and reports `REMOTE_DESCRIBE_ID_MISMATCH` (info): the describe never chooses a page, path or provider. |
| `version` | The sidecar's version, at most 64 characters; shown in its health detail. |
| `title` | The heading over its widgets, at most 80 characters; default the integration's `title`. |
| `columns` | Grid columns of its widgets from the `md` breakpoint up, 1–4; default 1. |
| `widgets` | Up to 24 widgets, each a [`ui.pages` widget](estate-config.md) **without `source`**, with a required `id` (not `links`, which deck uses for its link tiles). Each reads this integration's data. |
| `links` | Up to 32 `core/link-tiles` links (`title`, `href`, `description?`, `icon?`), shown as tiles below the widgets. |
| `nav` | Up to 8 sidebar links (`id`, `label`, `href`, `icon?`, `order?`), listed only when the integration's `page.nav` gives its page a sidebar entry, in that entry's group (`REMOTE_NAV_UNPLACED`, info, otherwise). |

Beyond the schema, deck checks what a schema cannot say:

- **Widget types are an allowlist** of deck's declarative types: `core/stat`, `core/stat-grid`,
  `core/meter`, `core/key-value`, `core/list`, `core/table`, `core/status-grid`,
  `core/link-tiles`, `core/markdown` and `core/json`. A sidecar cannot place `core/health-pills`,
  another module's widget, or `core/embed` (a frame), whatever `ui.allowUnsafeEmbeds` says.
- Each widget's `options` must satisfy its type's options schema, and its `select` the same
  size and work limits as a config page's; deck evaluates it on the server at each poll.
- `core/markdown` content goes through the same sanitiser as every markdown deck renders: raw
  HTML is parsed, then DOMPurify keeps only what it allows (no scripts, styles, frames, objects,
  embeds or forms, and no event handlers). There is no raw-HTML path for a sidecar.
- **Markdown links are external only.** Every target in a `core/markdown` widget's `content`
  (markdown links and images, reference definitions, autolinks, raw HTML `href`/`src`) must be
  an absolute `http(s)` URL, or the document is refused. Where it renders, every sidecar widget
  applies the same policy to whatever markdown it shows (its content, raw HTML in it, or text
  from the sidecar's data): an absolute `http(s)` link opens in a new tab with the external-link
  marker; any other (a path, a fragment, a protocol-relative `//host`, another scheme) becomes
  plain text. Markdown in your own `ui.pages` is unaffected.
- **Links:** a link's `href` is an `http(s)` URL or an absolute path in deck, and must pass
  deck's link check (no control characters, whitespace or backslashes, no protocol-relative
  `//host`, nothing that resolves off deck's origin). An `http(s)` URL always opens in a new tab
  with the external-link marker, even one that points at deck's own host: it is never treated
  as an in-app link. An absolute path stays in deck, so it can only reach deck's own pages.
- **Nav entries** take `http(s)` URLs only (shown with the external-link marker), never a path.
- Every string is bounded: ids, the version and icon names at 64 characters, titles and labels
  at 80, hrefs at 2048, and anything else at the bound of its widget option (20000 at most). An
  icon name outside the shell's icon set renders as a neutral icon.

Any failed check refuses the whole document, never part of it.

## What deck does with it

- **The page.** Each integration has a page, `page:remote/<id>`, at its `page.path`. It holds
  the sidecar's widgets in one section and its links below; until a describe gives it widgets it
  shows a fixed placeholder that says only which case it is (not described yet, unreachable,
  refused, or no widgets), never the problem itself. Widget ids are `widget:remote/<id>.<widget id>`. Like any page or widget,
  `ui.extensions` can switch one off, and a `ui.pages` page keeps a contested path from it. The
  sidecar's nav entries go with the page: while it is switched off or not routed, they are not
  listed.
- **Describe has its own cadence.** A poll starts it when it is due and never waits for it, and
  neither does boot. It has its own timeout: a slow or failing describe never delays a poll or
  fails the provider's health. After a good describe deck asks again every `describeIntervalMs`;
  after a failure it backs off, 5 s then doubling, up to `describeIntervalMs`. When deck stops,
  a describe in flight is cancelled and changes nothing.
- **The last good describe stands.** A describe that is refused (`REMOTE_DESCRIBE_INVALID`) or
  cannot be fetched (`REMOTE_DESCRIBE_UNREACHABLE`) leaves the last good one rendering, with the
  problem as a warning in `GET /api/ui` until a describe succeeds again.
- **Live.** A changed describe updates `GET /api/ui` without a restart (its ETag changes); an
  unchanged one changes nothing.
- **Health per sidecar.** Each integration is its own provider in `GET /api/health`: `ok` is the
  latest data poll's. After a good poll the detail names both requests, such as
  `data: HTTP 200, observed 2026-10-09T09:00:00Z; describe: ok (ups 1.0.0)` (a describe's outcome
  shows from the poll after it); after a failed poll it is the poll's error, as for every
  provider, and a describe problem is its `GET /api/ui` finding. A sidecar that is down degrades
  only its own entry, and deck carries on.
