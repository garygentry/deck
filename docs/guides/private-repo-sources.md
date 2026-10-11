# Use private repositories as sources

A source can point at a git repository instead of a local path, and that repository can be
private.
Deck authenticates the clone with a token it reads from the environment at run time, named — not
stored — in your estate config.
This guide shows how to name the credential, supply its value at deploy time, and verify the
fetch without leaking the secret.

For declaring sources and browsing them, see
[Serve docs and configs from your estate](./serve-docs-and-configs.md).
For the security rationale, see [Security & access posture](../security.md).

## Name the credential in config

Point the source at a git repository through `location.repo` (with an optional `ref`), and add
`credentialEnv`.
`credentialEnv` holds the *name* of an environment variable — never the secret itself.
The schema constrains it to an upper-snake-case identifier (`^[A-Z][A-Z0-9_]*$`), so it can
only ever look like a variable name.

```yaml
sources:
  - id: private-runbooks
    kind: markdown-tree
    title: Private runbooks
    location:
      repo: https://github.com/example-org/runbooks.git
      ref: main
    credentialEnv: RUNBOOKS_TOKEN
```

The same `credentialEnv` field exists on estate `integrations`, following the same
name-not-value rule.
Wiring a monitoring integration to a protected endpoint is covered in
[Connect monitoring and alerts](./connect-monitoring.md); this guide covers git sources.

## Provide the value at deploy time

Set the named variable in the deck process's environment — in your container definition, your
compose file, or the host's service manager.
Deck reads its value only when it acquires the source.

```bash
export RUNBOOKS_TOKEN=ghp_your_token_here
```

How deck uses the token (verified in `modules/sources/server/acquire.ts`):

- The token applies only to an **HTTPS** git remote.
  An `ssh://` or `git@` remote is left untouched — it uses its own key agent, and the token is
  ignored.
- When `credentialEnv` names a variable that is set, deck sends the token as an ephemeral
  Basic-auth header — `Authorization: Basic base64("x-access-token:<token>")` — injected into
  the clone through `GIT_CONFIG_*` environment variables, for that one clone process only.
  This follows the GitHub/GitLab personal-access-token convention (username `x-access-token`).
- The token is **never** placed in the clone URL or the git argument list.
  Git persists the remote URL to the clone's `.git/config` (and reflog), so a token in the URL
  would be written to disk in the cache — the header approach keeps it out of both.
- If `credentialEnv` names a variable that is unset or empty, deck attempts an unauthenticated
  clone (which is what a public repo needs).

Git-repo sources are cloned into an on-disk cache.
Set `DECK_SOURCES_CACHE_DIR` to control where; it falls back to a temp directory when unset.
The clone is shallow and non-interactive — deck disables credential prompts, so a missing or
wrong token fails fast rather than hanging.

## Verify without leaking

Confirm the fetch works by requesting the source's tree once deck is running:

```bash
curl http://localhost:8080/api/sources/private-runbooks/tree
```

A successful response is the source manifest.
For a repository source it includes a resolved `ref` (the checked-out commit), which confirms
deck cloned the private repo rather than serving nothing.
If acquisition fails — a missing token, a bad token, or an unreachable remote — the route
returns `500` with the code `SOURCE_UNAVAILABLE` and a generic message.

The secret stays contained by design:

- Config carries only the variable **name**, so the token never lands in your estate repo.
- Error responses carry a code and a canonical message only — never a path, an upstream git
  message, or a credential.
- Git's own output is drained and discarded during the clone (a failing clone can echo a
  tokenized URL), and deck's logs record only the source id and a failure kind.

To rotate the token, update the environment variable's value and restart deck; nothing in the
estate config changes.
