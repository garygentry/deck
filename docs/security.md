# Security & access posture

This is Deck's security model for v0.1.0 — what it assumes about its environment, what it
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
  filled in at request time. An authenticated request never follows a redirect off the
  configured origin. A response that contains the credential, nests deeper than 64 levels or
  exceeds the size cap (1 MiB by default) is refused, not published, and poll errors name the
  failure class only, never the credential, body or runtime error text. The URL is reached from the deck server, so whoever edits the estate
  config chooses what deck fetches on its network.
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
- **The one write route has its own gate.** `POST /api/llm-usage/ingest` exists only when its
  token env var is set. It checks the bearer token in constant time, caps bodies at 2 MB, and
  only ever updates the displayed statusLine numbers.

## Operator responsibilities

- Put an authenticating reverse proxy in front of Deck; keep its port off untrusted networks.
- Provide credentials only through the environment (never commit them into estate config).
- Curate source `include`/`exclude` so the Configs/Docs surfaces expose only what you intend.
- Leave actions disabled unless you've provisioned and reviewed the runner allowlist.
- If you exempt the LLM usage ingest route from proxy auth, exempt exactly
  `POST /api/llm-usage/ingest`, and treat its token like any other credential.

## Reporting

For a suspected vulnerability, contact the maintainer privately rather than opening a public
issue.

## Reference

- Deploying & reverse proxy: [guides/deploy.md](guides/deploy.md).
- Estate config & credentials: [guides/configure-your-estate.md](guides/configure-your-estate.md).
- Governed actions internals: [`docs/architecture/governed-actions.md`](architecture/governed-actions.md).
