# Serve docs and configs from your estate

Deck can expose the runbooks and configuration files that live beside your estate as
read-only browsable trees.
A Markdown tree renders in the Docs surface with syntax highlighting; a plain file tree
shows verbatim in the Configs surface.
This guide walks you from declaring a source to browsing and searching it in the UI.

For the design and internals behind this feature, see
[Sources: docs and configs](../architecture/sources-docs-and-configs.md).
To point a source at a private git repository, see
[Use private repositories as sources](./private-repo-sources.md).

## Declare a source

Sources are declared in your estate config under the top-level `sources` list.
Each entry needs four required fields: `id`, `kind`, `title`, and `location`.

Pick a `kind` that matches how the files should be presented:

- `markdown-tree` — a documentation tree, rendered as sanitized HTML in the Docs surface.
- `file-tree` — a configuration tree, shown verbatim in the Configs surface.

Any other `kind` is silently ignored at boot, so a typo produces no source rather than an
error.

The `location` points at either a local filesystem `path` or a git `repo` (with an optional
`ref`).
This guide covers local paths; git repositories are covered in
[Use private repositories as sources](./private-repo-sources.md).

The bundled example estate declares one source of each kind — copy them as your model
(`examples/estate/10-overlay.yaml`):

```yaml
sources:
  - id: runbooks
    kind: markdown-tree
    title: Runbooks
    location: { path: examples/estate/docs }
  - id: host-configs
    kind: file-tree
    title: Host configs
    location: { path: examples/estate/configs }
```

A local `path` is read in place — deck never copies or writes to it.
A relative path resolves against deck's working directory, so prefer an absolute path (or a
container mount point) in a real deployment.

### Curate the tree with globs

Add optional `include` and `exclude` glob lists to control which files appear.
Patterns match against the POSIX path relative to the source root (for example
`docs/setup.md`), and a file is shown only when it passes `include` and is not matched by
`exclude`.

```yaml
sources:
  - id: runbooks
    kind: markdown-tree
    title: Runbooks
    location: { path: /srv/estate/docs }
    include: ["**/*.md"]
    exclude: ["**/drafts/**"]
```

With no `include`, every file is included; with no `exclude`, none is excluded.
The same globs apply to reads by path: a file left out of the tree reads as `404`
`PATH_NOT_FOUND`, the answer a missing file gets. An image a document embeds is the exception
for `include` only, so an `include` that lists only Markdown still shows its images; an
`exclude` hides images too.
Dotfiles are matched verbatim and are not hidden by default — curating what a source exposes
is your job, so exclude anything sensitive.

## Enable the sources capability

There is no separate on/off switch for sources.
The capability activates for a source as soon as you declare it with a supported `kind`
(`markdown-tree` or `file-tree`) and deck boots with that config.

At boot, deck builds one store per supported-kind source and registers four read-only routes
per source id:

```text
GET /api/sources/:id/tree
GET /api/sources/:id/file?path=<relative-path>
GET /api/sources/:id/raw?path=<relative-path>
GET /api/sources/:id/search?q=<query>
```

A request for an id that is not declared (or whose `kind` was ignored) returns `404` with the
code `SOURCE_NOT_FOUND`, so an unknown source is indistinguishable from a disabled one.

For a local-path source you need no extra environment.
`DECK_SOURCES_CACHE_DIR` matters only for git-repo sources — it is the on-disk cache root for
cloned trees, and it falls back to a temp directory when unset.

## Browse and search

Once the source is declared and deck is running, open the Docs or Configs surface in the web
UI and select the source by its `title`.

**Tree.**
The tree view lists directories first, then files by name.
A directory that contains no renderable file after your `include`/`exclude` filters is pruned
from the tree, so an over-filtered source can legitimately show an empty tree
(`fileCount: 0`).

**File view.**
Selecting a file shows its contents, with a language hint chosen from the file extension for
highlighting.
Deck suppresses the body in two cases and shows a placeholder instead:

- the file is larger than 1 MiB (reported as truncated), or
- the file looks binary (a NUL byte in its leading 8 KiB).

**Images.**
Relative images referenced from rendered Markdown load through the `raw` route, which serves
image bytes only — any non-image path is refused. Every image is served under a sandboxing
Content-Security-Policy, so an SVG holding script, opened by its URL, runs no script on
deck's origin; in a document it renders like any other image.

**Search.**
The search box queries one source at a time.
Matching is case-insensitive substring, over both file names/paths and file contents, and it
returns up to 200 matches.
Binary files and files over the size cap are matched by name only — their contents are never
scanned.
When the cap is reached the result is marked truncated and the UI invites a narrower query.

Every path in every route is resolved through a single confinement check that rejects `..`,
absolute paths, NUL bytes, and symlink escapes, so a source can never serve a file outside its
declared root.
