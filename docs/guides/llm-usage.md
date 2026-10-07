# Track Claude Code and Codex plan usage

Deck can show how much of your Claude Code (Claude.ai Pro/Max) and Codex (ChatGPT plan) usage
limits you have used: the current session window, the weekly windows and per-model limits,
each with its reset time.
The numbers appear on the **LLM usage** page (`/usage`), as a pill in the health header (the
tightest limit), and as tiles at the top of the portal.

This guide shows how to enable the feature, give deck the credentials and files it reads, and
push live Claude Code numbers through the statusLine hook.

## How deck gets the numbers

Neither provider publishes a stable usage API, so deck combines several sources and shows,
for every bar, which source produced it and how old it is.

| Source | Provider | What it gives | Needs |
| --- | --- | --- | --- |
| statusLine push | Claude | Session and weekly percentages, pushed on every prompt. Freshest source. | The hook below and an ingest token. |
| OAuth usage endpoint | Claude | Every panel row, including per-model limits. Called at most once every 2 minutes, including by Refresh. | `credentialsFile` |
| Local transcripts | Claude | Token counts for the last 5 hours and 7 days. Consumption, not quota. | `transcriptsDir` (optional) |
| app-server rate limits | Codex | Every limit window, from the `codex app-server` deck runs. | `codexHome` |
| Rollout files | Codex | The latest limits written by any Codex process sharing the home. A new turn also makes deck poll at its active interval. | `codexHome` (or `rolloutDir`) |
| Usage history | Codex | Lifetime tokens, streaks, and tokens per day. | `codexHome` |

When the statusLine and OAuth sources both report the same window, a statusLine push from
the last 5 minutes wins; otherwise the more recent of the two wins. A rate-limited OAuth poll
therefore costs at most the per-model rows, and an old OAuth value never hides a newer push.

## Enable it in the estate config

Add a `modules.llm-usage` section. Both `claude` and `codex` are optional; include the ones
you use. Without a `modules.llm-usage` section the feature is off: no polling, no ingest route, and
the page says it is not configured.

```yaml
modules:
  llm-usage:
    claude:
      credentialsFile: /data/claude/.credentials.json
      transcriptsDir: /data/claude/projects
      statusLine:
        credentialEnv: DECK_LLM_USAGE_INGEST_TOKEN
      activeInterval: PT2M   # OAuth poll interval while you are working (minimum PT2M)
      idleInterval: PT5M     # OAuth poll interval otherwise (minimum PT2M)
    codex:
      codexHome: /home/you/.codex
      command: /home/you/.codex/packages/standalone/current/bin/codex
    thresholds:
      warn: 75
      danger: 90
    idlePause: PT5M
```

- `credentialEnv` is the **name** of an environment variable, never the token itself, like
  every other `credentialEnv` in the estate config.
- Intervals are clamped between two minutes and one day. The OAuth endpoint rate-limits
  aggressively, and the statusLine push gives faster updates anyway.
- `idlePause`: when nobody has viewed usage (the page, the header pill or the portal) for this
  long, deck stops polling upstream. The next view wakes it.
- A bar turns warn at `thresholds.warn` percent and danger at `thresholds.danger` percent, or
  as soon as the provider reports the limit as reached. Setting only `danger` below 75 lowers
  `warn` to match.
- `deck validate` reports malformed or zero durations and a `warn` above `danger`
  (`LLM_USAGE_INVALID`); deck refuses to start with them too.

See the [estate configuration reference](../reference/estate-config.md#llmusage) for every key.

## Mount the credentials and data

Deck runs in a container, and the image contains no Claude or Codex software. It reads your
credentials and files from the host through volume mounts, and runs your own `codex` binary
from the host.

### Claude Code

Deck needs no Claude binary. It calls the OAuth usage endpoint itself, with the access token
from your Claude Code credentials file, and it reads transcripts as plain files. Mount the
`.claude` directory read-only:

```yaml
services:
  deck:
    volumes:
      - ${HOME}/.claude:/data/claude:ro
```

Then set `credentialsFile: /data/claude/.credentials.json` and, optionally,
`transcriptsDir: /data/claude/projects`.

- Mount the directory, not the credentials file on its own. When Claude Code replaces the
  file to refresh the token, a single-file bind mount keeps showing the old copy.
- Deck re-reads the file on every poll, but never refreshes or writes the token. Claude Code
  on the host refreshes it whenever you use it. If you have not run Claude Code for a while,
  the token expires and the OAuth source reports `HTTP 401 (token expired; run claude on the
  host to refresh)`. Running `claude` once fixes it.
- If Claude Code on the host keeps its credentials in the macOS keychain instead of
  `~/.claude/.credentials.json`, there is no file to mount. Use the statusLine hook (below),
  which needs no credentials file at all.

### Codex

Deck runs `codex app-server` from your host installation, with `CODEX_HOME` set to your Codex
home. The app-server refreshes `auth.json` itself, so the home must be mounted read-write, and
it must be your own `~/.codex`, not a copy: Codex rotates its refresh token, so two copies of
`auth.json` would sign each other out. Sign in once on the host with `codex login`; until then
the page reports "sign-in needed".

The binary has to be a Linux build for the container's architecture. Codex's Linux builds are
static (musl), so they run in deck's Alpine image. How you mount it depends on how Codex is
installed on the host.

**Standalone installer** (`~/.codex/packages/standalone`). Check with
`readlink -f "$(command -v codex)"`: the path contains `packages/standalone/releases/`.
The binary lives inside the Codex home, reached through `current`, an *absolute* symlink.
Mount the Codex home at the same absolute path inside the container, so that the symlink
resolves and survives Codex's own upgrades:

```yaml
services:
  deck:
    volumes:
      - /home/you/.codex:/home/you/.codex
```

```yaml
modules:
  llm-usage:
    codex:
      codexHome: /home/you/.codex
      command: /home/you/.codex/packages/standalone/current/bin/codex
```

**npm** (`npm install -g @openai/codex`). The `codex` command on your PATH is a Node script
that deck's image cannot run. Mount the native binary it wraps instead. Find it with:

```bash
find "$(npm root -g)/@openai" -path '*-unknown-linux-musl/bin/codex' -type f
```

For example, with `npm root -g` at `/usr/lib/node_modules` on an x64 host:

```yaml
services:
  deck:
    volumes:
      - /home/you/.codex:/home/you/.codex
      - /usr/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex:/usr/local/bin/codex:ro
```

Then set `command: /usr/local/bin/codex`, or leave `command` out, since `codex` on `PATH` is
the default. This mount pins the file you mounted, so restart deck after upgrading Codex.

**Another OS, or no Codex on the host** (for example, deck on a Linux server and Codex on a
Mac). Download the Linux build for the server's architecture (`linux-x64` or `linux-arm64`)
and mount it the same way:

```bash
npm pack @openai/codex@linux-x64 && tar xzf openai-codex-*-linux-x64.tgz   # or @linux-arm64
# the binary is package/vendor/x86_64-unknown-linux-musl/bin/codex
```

Check the setup on the **Diagnostics** list. `codex not found at "…"` means the `command`
path does not exist inside the container, and `sign-in needed` means the home has no valid
login.

> **File ownership.** The deck image runs as root, and `codex app-server` writes more than
> `auth.json` into its home: state databases, logs and temp files. On a shared `~/.codex`,
> files it creates or replaces become root-owned on the host, and your own `codex` may then
> fail to update them. Until deck can run the app-server as your user, either run the deck
> container as your uid (`user: "1000:1000"` in compose, with writable volumes for that uid),
> or check `ls -ln ~/.codex` after first start and `chown -R` it back. Because deck runs your
> host's binary, its version always matches your own `codex`.

## Push live Claude Code numbers with the statusLine hook

Claude Code runs a statusLine command before each prompt and passes it a JSON payload
that includes the current rate limits.
`scripts/statusline-ingest.sh` forwards that payload to deck, then prints a short status line
(model and session usage).

1. Generate a token, give it to deck, and store it in a private file for the hook:

   ```bash
   umask 077 && openssl rand -hex 32 > ~/.config/deck-ingest-token
   ```

   Set the same value as `DECK_LLM_USAGE_INGEST_TOKEN` in deck's environment (the variable
   named by `statusLine.credentialEnv`).
   Deck registers `POST /api/llm-usage/ingest` only when the variable is set.
   In the environment Claude Code runs in, set `DECK_URL` (use `https://` unless deck is on
   a trusted LAN) and `DECK_LLM_USAGE_INGEST_TOKEN_FILE=~/.config/deck-ingest-token`.
   The script also accepts the token itself in `DECK_LLM_USAGE_INGEST_TOKEN`, but then every
   tool and MCP server Claude Code starts inherits it.

2. Point Claude Code at the script in `~/.claude/settings.json`:

   ```json
   {
     "statusLine": { "type": "command", "command": "/path/to/deck/scripts/statusline-ingest.sh" }
   }
   ```

The script posts in the background with a 3-second timeout and its own input and output, so
an unreachable deck never slows your prompt.
It passes the token in a header read from standard input and the payload through a private
temp file, so neither shows up in the process list.
It always prints a line, and prints `Claude` when `jq` is missing.

### Behind a reverse proxy

If your proxy requires sign-in for deck, exempt exactly `POST /api/llm-usage/ingest` from proxy
auth (the exact path and method, not a prefix), so the hook can reach it.
Deck checks the bearer token on that route itself (a constant-time comparison), rejects a wrong
token with 401, and refuses bodies over 2 MB.
Keep every other path behind the proxy.

## Read the page

Each bar shows the percent used, when the window resets, which source produced it, and how
long ago.
The **Diagnostics** section lists every source with its state:

| State | Meaning |
| --- | --- |
| Available | Delivering data. |
| Not configured | Deck was not given what this source needs, or the account needs to sign in. |
| Not applicable | Plan limits do not apply to this account (for example, an API key). |
| No data yet | Configured, but nothing has arrived yet, such as before the first statusLine push. |
| Stale | The last poll failed; the last good numbers are still shown. |
| Error | The source failed and has no good numbers to show. |

The **Refresh** button asks deck to poll immediately. It is debounced to once every five
seconds. It always re-reads Codex, but calls the OAuth endpoint only when the last call was at
least two minutes ago and deck is not backing off from a rate limit.

## Check it from the command line

```bash
curl -s https://deck.example.lan/api/llm-usage | jq '.claude.bars, .codex.sources'
curl -s https://deck.example.lan/api/health | jq '.llmUsage'
```

The `llmUsage` entry in `/api/health` shows the poll mode (`active`, `idle`, `backoff` or
`paused`) and the consecutive error count. It never changes the overall health status.
