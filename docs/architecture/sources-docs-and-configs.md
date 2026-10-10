# Sources: docs and configs

Deck can browse read-only documentation and configuration files that live beside the estate — Markdown docs rendered in the browser, and config files shown verbatim. Each browsable tree is a declared **source**: either a local filesystem path or a git repository. The server acquires the source into a confined, bounded on-disk tree and serves it through read-only routes; the browser renders the tree, files, and search results without ever performing source I/O of its own.

Two source kinds are supported:

- `markdown-tree` — a documentation tree; Markdown files render to sanitized HTML with syntax highlighting, and relative images resolve through the raw route.
- `file-tree` — a configuration tree; files are shown verbatim, with no rendering or redaction.

## Runtime flow

The capability is three built-in modules: the `markdown-tree` and `file-tree` data sources (`modules/<kind>/server/module.ts`) and the `sources` feature (`modules/sources/server/module.ts`).

1. While providers are registered at startup, each data-source module's kind handler builds one `SourceStore` (reading `DECK_SOURCES_CACHE_DIR`) and one provider per `sources[]` entry of its kind, and offers a reader over its stores as the `sources/reader` module service. Each provider acquires its source and publishes a bounded tree **manifest** (the directory structure and per-file metadata — never file bodies). A source id is an estate id: one equal to any other provider's id fails boot (`PROVIDER_DUPLICATE_ID`).
2. The `sources` module's init creates the cache root, prunes the caches of sources no longer declared in `sources[]`, and registers the four read routes (`registerSourceRoutes`) on its module routes. The routes read the stores through the `sources/reader` service of every running data source, so another module can serve a source through the same routes by offering that service. A declared source is answered only by the reader of the module that owns its kind; any other reader claiming it is ignored and logged (`sources.reader-claim`). An undeclared id is answered by a built-in reader first, then by the one non-built-in reader serving it; when several non-built-ins serve it, none answers (404) and the conflict is logged.
3. The browser's Docs and Configs pages poll `/api/config` for the declared sources, then call the source routes on demand: the manifest up front, individual file contents and search results only when the reader asks.

File bodies, images, and search are served **on demand** from the confined tree — the manifest carries structure and metadata only, so opening a large tree never ships its contents.

## Acquisition and confinement

A **local-path** source is used in place; nothing is copied. A **git-repo** source is shallow-cloned (`--depth 1 --single-branch`, pinned to `location.ref` when set) into a per-source directory under the cache root, then published atomically by swapping a `current` symlink. A failed refresh leaves the last-good tree in place — a reader never observes a half-updated or empty tree.

Every path a request names is resolved through `confine()` (realpath containment): the requested relative path must resolve to a real location inside the source root. Traversal attempts, absolute paths, escaping symlinks, encoded separators, and NUL bytes are rejected **before** any read, and the rejection never echoes the attempted filesystem path. The tree walk additionally guards against in-root symlink cycles (a self- or ancestor-pointing symlink is skipped, not re-descended) and caps depth, so a pathological tree cannot inflate the manifest or loop.

### Private-repo credentials

A git source may name an environment variable in `Source.credentialEnv`. The value of that variable is read at acquisition time, through the env reader the kernel gives the source's module for that source alone (a name the kernel reserves or another module owns reads as unset), and used as a Basic-auth token (`x-access-token:<token>`) for the HTTPS clone. The credential is passed to git as an **ephemeral `http.extraheader`** injected through `GIT_CONFIG_*` environment for the clone process only — it is never written into the clone URL or argv, so it never lands in the clone's `.git/config` or reflog, and it is never logged (git output is drained and discarded; failures log only `{ sourceId, failureKind }`). `credentialEnv` holds the variable **name**, never the secret itself. Non-HTTPS remotes (`ssh://`, `git@…`) ignore it and rely on their own key agent.

## Routes

`registerSourceRoutes` adds exactly four routes, all `GET` (the capability is strictly read-only). They answer under the module prefix `/api/m/sources` and at the legacy alias `/api/sources`, with identical responses:

- `GET /api/sources/:id/tree` — the `SourceManifest` (structure + per-file metadata; POSIX-relative paths only).
- `GET /api/sources/:id/file?path=<rel>` — a `FileReadResult`. A file over the size cap returns `truncated: true` with no body; a binary file is flagged rather than returned as text.
- `GET /api/sources/:id/raw?path=<rel>` — raw bytes for a Markdown-relative **image** only; non-image content types are refused. Served with `X-Content-Type-Options: nosniff` and `Content-Security-Policy: sandbox; default-src 'none'; style-src 'unsafe-inline'`, so an SVG opened by its URL runs no script and fetches nothing on deck's origin.

`file` and `raw` apply the source's `include`/`exclude` as the tree does: a path outside the tree answers `404` `PATH_NOT_FOUND`, like a missing file. `raw` applies `exclude` only, so the images a document embeds load under an `include` that lists only documents.
- `GET /api/sources/:id/search?q=<q>` — a `SourceSearchResult` of name and content matches, scoped to the confined tree and capped.

An unknown source id, or one of a kind no running module serves, yields `404` `SOURCE_NOT_FOUND`, as does every route while the `sources` module is not running; a confinement or missing-parameter failure yields `400`; neither leaks a filesystem path.

## Web UI

The sources module's manifest declares the UI as data, in `@deck/contract/modules/sources` (`SOURCES_UI`), which the server manifest spreads in. It contributes two pages, listed in the `knowledge` nav group, and an owned-configs `entity-section` on each detail page:

- `/docs` (nav label "Docs") — the `markdown-tree` browser: a tree view, rendered Markdown with a table of contents and syntax highlighting, and search.
- `/configs` (nav label "Configs") — the `file-tree` browser: verbatim file viewing with a notice that content is shown exactly as stored, no redaction.
- An **owned-configs** section ("Configs", in the shared `configs` section at order 20): `section:sources/host-configs` on `entity:host/sections` and `section:sources/service-configs` on `entity:service/sections`, after drift's findings (order 10). It surfaces the config files a given host or service owns (via each source's optional `owner`).

The web half (`modules/sources/web/index.ts`) supplies only the components the manifest names (`DocsPage`, `ConfigsPage`, `OwnedConfigsFragment`) and registers them with `registerWebModule`; where each one renders comes from the manifest, and the UI manifest (`GET /api/ui`) decides at runtime.

Markdown is rendered with `markdown-it`, sanitized with DOMPurify, and highlighted with highlight.js — all in the browser, by the kernel's markdown pipeline (`apps/web/src/ui/lib/markdown.ts`), which the dashboard markdown widget shares; the module supplies only the Docs view's link and image rewrites (`web/markdown-context.ts`). Oversized files show a "too large" notice (reporting the size in MiB); binary files show a placeholder instead of bytes.

## Configuration

### Cache directory

`DECK_SOURCES_CACHE_DIR` sets the on-disk root for acquired git trees:

```bash
DECK_SOURCES_CACHE_DIR=/var/lib/deck/sources-cache bun apps/server/src/server/boot.ts
```

When unset, the cache defaults to `deck-sources-cache` under the OS temp directory. The directory is created on startup if missing; if it cannot be created, startup fails with a sanitized configuration error. Caches for sources no longer declared are pruned.

### Source declaration

Each source is declared in estate config under `sources[]`:

| Field | Meaning |
|-------|---------|
| `id` | Unique source id (also the cache subdirectory and route segment). |
| `kind` | `markdown-tree` or `file-tree`; each kind's module checks the entry against its instance schema. |
| `title` | Human-readable label shown in the UI. |
| `location.path` | Filesystem path (local-path source), or… |
| `location.repo` + `location.ref` | HTTPS/SSH git remote and optional branch/tag/ref (git source). |
| `include` / `exclude` | Optional glob patterns bounding the browsable tree. |
| `owner` | Optional `{ host, service? }` linking config files to an inventory entity (drives the owned-configs section). |
| `credentialEnv` | Optional environment-variable **name** holding a private-repo token (see Private-repo credentials). Never the token value. |

### Fixed bounds

These safety bounds are implementation constants, not operator settings:

- file size cap: **1 MiB** (larger files are reported `truncated`, body omitted)
- binary sniff window: **8 KiB** (a NUL byte within it marks the file binary)
- read chunk size: **64 KiB** (reads are streamed, never buffered whole beyond the cap)
- search matches: **200** total, **5** per file; snippet length **200** characters
- tree depth: **128**

## When to use

- Publishing a documentation tree (a repo's `docs/`, a wiki export) for in-app reading beside the estate.
- Surfacing configuration files — especially host- or service-owned configs — for read-only inspection.

## When not to use

- Editing or writing files: the capability is strictly read-only; there are no mutating routes.
- Serving large binary assets or arbitrary downloads: only Markdown-relative images are served raw, and files are size-capped.
- Storing secrets in config values: `credentialEnv` names an environment variable; never place a token or password directly in the source declaration.
