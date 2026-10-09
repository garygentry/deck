# Security & access posture

This is Deck's security model — what it assumes about its environment, what it
protects, and what it deliberately leaves to the operator. Read it before exposing Deck
anywhere beyond your own machine.

## Access model: authenticating reverse proxy

**Deck has no built-in authentication or authorization.** It serves plain HTTP and treats
every request that reaches it as trusted. The intended deployment is **behind a reverse proxy
on a private network** that terminates TLS and enforces access (SSO, basic auth, an identity-
aware proxy, a VPN/tailnet, etc.).

- Do **not** expose Deck's port directly to an untrusted network.
- Forward both `/` and `/api` to the same upstream — they are one process.
- See [the deploy guide](guides/deploy.md) for a reverse-proxy example.

Built-in auth is intentionally out of scope for v0.1.0; the reverse-proxy assumption keeps the
engine generic and delegates authentication to infrastructure that already does it well.

## What Deck protects

Even trusting the network, Deck holds several boundaries so a malicious *estate/source input*
can't escalate:

- **Governed actions are safe-by-default.** The actions capability is **disabled** unless an
  operator sets `DECK_ACTIONS_ENABLED` *and* provisions a runner allowlist
  (`DECK_RUNNERS_FILE`). A declared action names a **runner**, never a shell command; Deck
  never constructs a command line from config, and a runner name that isn't in the manifest is
  refused. Parameters are passed to the runner on stdin, not as interpolated argv. See
  [`docs/architecture/governed-actions.md`](architecture/governed-actions.md).
- **Secrets stay in the environment.** Credentials are referenced by env-var **name**
  (`credentialEnv` / integration tokens), never stored as values in estate config. For private
  git sources the token is injected as an ephemeral `http.extraheader` via `GIT_CONFIG_*` for
  the clone process only — never placed in the clone URL, the process arg list, or the on-disk
  `.git/config`. `hosts[].secrets` / `services[].secrets` are opaque reference ids, not values.
- **`http-json` polls only what config names, and keeps its credential to that origin.** An
  `http-json` integration's URL must be `http(s)` without `user:password@`. Literal headers,
  URL query parameters and body keys may not take credential-like names, so the only credential
  is the `credentialEnv` variable, sent as a header or (`auth.scheme: query`) a query parameter
  filled in at request time; it must hold at least 8 characters. An authenticated request never follows a redirect off the
  configured origin. A response that contains the credential, nests deeper than 64 levels or
  exceeds the size cap (1 MiB by default) is refused, not published, and poll errors name the
  failure class only, never the credential, body or runtime error text. The URL is reached from the deck server, so whoever edits the estate
  config chooses what deck fetches on its network. A `remote` integration's requests to its sidecar go through the same
  request path with the same guarantees: the credential from `credentialEnv` only, and the same
  size, depth and timeout bounds. A sidecar may never redirect deck off its own origin, with a
  credential or without.
- **A sidecar contributes data and declarations, never code.** A `remote` integration's requests
  get the same hardening as `http-json`'s, on both endpoints. Its describe document may place only
  deck's declarative widget types (never `core/embed` or another module's widget, whatever
  `ui.allowUnsafeEmbeds` says), with bounded strings, options checked against each type's schema,
  `select`s within the server's limits, and links that pass deck's link check; `http(s)` links
  always open as external links. Its markdown goes through the same DOMPurify boundary as all
  markdown, and keeps only absolute http(s) links, shown as external; any other becomes text. A refused document is dropped whole, and the last good one stays. Its widgets read
  only its own integration, and its page path and sidebar placement come from estate config,
  never from the sidecar.
- **Source paths are confined.** Every file a source exposes is resolved through a single
  choke point that rejects `..`, absolute paths, NUL bytes, and symlink escapes, and proves the
  resolved (symlink-collapsed) path lives inside the source root.
- **Rendered markdown is sanitized.** Untrusted repository markdown passes through a single
  enforced DOMPurify boundary before it reaches the DOM — there is no un-sanitized render path.
- **Config files render verbatim.** The Configs surface shows files **as-is** — Deck does not
  scan or redact them, and says so in-product. **The operator curates what is exposed** via
  each source's `include` / `exclude` globs. Don't point a source at a tree containing secrets
  you don't want shown.
- **LLM usage holds account credentials, and it's opt-in.** With a `modules.llm-usage` section, deck
  reads a Claude Code credentials file (read-only; never written, refreshed or returned by the
  API) and runs the host's own `codex app-server` binary (mounted; the image ships none)
  against a writable Codex home, which refreshes its own tokens. The Codex child inherits only a short env allowlist plus `CODEX_HOME`, so deck's
  other secrets never reach it. Anyone who can reach deck sees the usage numbers, never the
  tokens.
- **Runtime modules are off unless you switch them on, and run with full trust.** deck imports
  a runtime module's code from `DECK_MODULES_DIR` only while `DECK_MODULES_ENABLED` is on. That
  code runs in the deck process with all of deck's privileges: no sandbox separates it from
  deck's environment, files or network. Its web half runs in the browser as deck itself, with
  the viewer's session and every `/api` route. An optional `moduleIntegrity` pin stops a module
  directory that has changed since you pinned it from loading. See
  [Run a runtime module](guides/runtime-modules.md).
- **The one write route has its own gate.** `POST /api/llm-usage/ingest` exists only when its
  token env var is set. It checks the bearer token in constant time, caps bodies at 2 MB, and
  only ever updates the displayed statusLine numbers.

## Trust tiers

Each way of extending deck gets the trust its form allows. Climb only as far as you need.

| Tier | What it can do | What deck enforces | What you own |
| --- | --- | --- | --- |
| Built-in modules | Anything: they are deck. | Reviewed with deck. A built-in whose manifest or config schema is unusable stops boot rather than switching itself off. | Which ones you enable, and their settings. |
| Config-driven UI (`ui`: brand, nav, pages, widgets, `select`) | Arrange and relabel deck's own UI, and show provider data through deck's widgets. No code runs. | The `ui` schema; widget options checked against each type's schema; `select` evaluated on the server with step, size and depth budgets; links pass deck's link check; markdown sanitized. | Whoever edits the config chooses what appears and what deck fetches. |
| `core/embed` | Show another site's page in a sandboxed frame. | Off unless `ui.allowUnsafeEmbeds: true`; `http(s)` only, never deck's own origin; a sandbox from a fixed list; no referrer; the page may frame only those origins (CSP `frame-src`), so a redirect into deck is refused. | Embed only sites you trust: the page runs in each viewer's browser with that browser's cookies for its site. |
| `http-json` | Poll a URL you name and publish its JSON. | The credential only from `credentialEnv`, never off its origin; size, depth and timeout caps; responses that echo the credential refused. | The URL is reached from deck's network: the config author chooses what deck fetches. |
| `remote` sidecars | Contribute data, and declarative widgets, links and nav. | Its describe document is **untrusted input**: schema-checked, deck's declarative widget types only (never `core/embed`), bounded strings, `select` limits, link checks, external-only links in its markdown; its widgets read only its own integration; its page path and nav placement come from config; no redirect off its origin. | Run sidecars you trust with the data you give them. |
| Runtime modules (`DECK_MODULES_DIR`) | Anything deck can: the server half runs in the deck process, and `web.js` runs in deck's page as deck. | Off unless `DECK_MODULES_ENABLED`; a `deckApi` check; an optional `moduleIntegrity` pin checked just before each import; load failures shown as fixed categories, never the module's error text; `web.js` served same-origin and loaded under deck's CSP (no `eval`, requests to deck only). | Full trust: install only modules you have reviewed, mount the directory read-only and pin each one. A pin protects the files at rest only: it does not stop someone who can write the directory while deck starts. |
| Contributed icons | SVG markup in a module's manifest. | Rebuilt through an element and attribute allowlist: no scripts, no `style`, no external references. | — |

## Browser policy

Every response carries `frame-ancestors` (in a `Content-Security-Policy` header) and
`X-Content-Type-Options: nosniff`. By default only deck's own origin may frame deck, and
`X-Frame-Options: SAMEORIGIN` says so to older browsers too. To show deck inside another app,
such as a Home Assistant panel, list that app's origin in `ui.frameAncestors`. deck then omits
`X-Frame-Options`, which cannot name another origin. The setting takes effect without a restart.

The web shell's page carries a Content-Security-Policy that browsers enforce:

- **Scripts** come from deck's origin only: the app, `@deck/sdk` and runtime modules' `web.js`.
  The page's two inline scripts (the import map and the theme script) carry a nonce that is new
  on every response, and no `eval` runs. The page is served `Cache-Control: no-cache`, so a
  cached copy never outlives its nonce.
- **Requests** (`fetch`) go to deck's origin only.
- **Frames** may show only the origins of the `core/embed` URLs in the config, and none while
  `ui.allowUnsafeEmbeds` is off. deck's own origin is never among them.
- **Styles** may be inline as well as deck's own, and **images** may come from any `http(s)`
  URL (brand logos, images in docs). A sanitized page cannot inject a script, but it can show an
  image from another site.
- No plugins, no `<base>`, and forms post to deck only.

If your reverse proxy sets its own `Content-Security-Policy` or `X-Frame-Options`, the browser
applies both policies; keep the proxy's at least as permissive as deck's, or drop them.

## Operator responsibilities

- Put an authenticating reverse proxy in front of Deck; keep its port off untrusted networks.
- Provide credentials only through the environment (never commit them into estate config).
- Curate source `include`/`exclude` so the Configs/Docs surfaces expose only what you intend.
- Leave actions disabled unless you've provisioned and reviewed the runner allowlist.
- Leave runtime modules disabled unless you trust every module in `DECK_MODULES_DIR`. Mount
  that directory read-only, and pin each module's digest in `moduleIntegrity`.
- List in `ui.frameAncestors` only the apps you mean to frame deck: any page on those origins
  can then show deck, and its actions, inside itself.
- If you exempt the LLM usage ingest route from proxy auth, exempt exactly
  `POST /api/llm-usage/ingest`, and treat its token like any other credential.

## Reporting

For a suspected vulnerability, contact the maintainer privately rather than opening a public
issue.

## Reference

- Deploying & reverse proxy: [guides/deploy.md](guides/deploy.md).
- Estate config & credentials: [guides/configure-your-estate.md](guides/configure-your-estate.md).
- Governed actions internals: [`docs/architecture/governed-actions.md`](architecture/governed-actions.md).
