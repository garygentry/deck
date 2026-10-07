# Governed actions

Deck can execute pre-declared, operator-provisioned write actions against the estate —
restarting a service, running a maintenance script — and stream their output live to
the browser. The capability is off by default; every existing read-only deployment
boots unchanged until an operator explicitly opts in and provisions a runner allowlist.

## Runtime flow

1. The capability is the built-in `actions` module (`apps/server/src/actions/module.ts`).
   The module host runs it only when `DECK_ACTIONS_ENABLED` is on. When it is off, no
   module code runs and no manifest is read: the module's prefixes answer fixed,
   declared responses instead, so the capability probe reports `{"enabled": false}` and
   every other action route refuses with `403`.
2. When enabled, the module's init loads and validates the runner manifest (see Runner
   manifest below), builds the append-only audit store, and creates an executor backed
   by a real child-process spawner. The runtime, executor and audit store exist only
   inside that init, and no module API path reaches them: the module owns
   `DECK_ACTIONS_ENABLED`, `DECK_RUNNERS_FILE` and `DECK_ACTION_TIMEOUT_MS`, so the host
   refuses any other module that declares one, and a config pointer cannot unlock them
   (nor the kernel's `DECK_DATA_DIR`). This is an API boundary, not an OS sandbox: any
   in-process module code runs with deck's full privileges.
3. A `POST /api/actions/:id` request passes four gates in order — capability enabled,
   action declared, runner resolved, parameters valid — and only then spawns the
   runner and streams its stdout/stderr as newline-delimited JSON (NDJSON) events over
   the response body.
4. Every run — including a pre-run refusal — appends exactly one entry to the audit
   index, then the run's own output is available to read back.
5. A client disconnect never cancels the run: the server keeps draining and recording
   it server-side and it remains visible in the audit history afterward.

## Routes

| Route | Method | Purpose |
|---|---|---|
| `/api/actions` | GET | Capability probe: `{"enabled": true|false}`, always 200 |
| `/api/actions/:id` | POST | Invoke a declared action; streams NDJSON events |
| `/api/actions/runs/:runId/cancel` | POST | Cancel an in-flight run |
| `/api/actions/audit` | GET | List audit entries, newest first |
| `/api/actions/audit/:runId` | GET | Read one run's full captured output |

The module serves these routes at `/api/m/actions` and keeps `/api/actions` as an alias
with identical responses. Both are mounted before the SPA static/index fallback, so
`/api/actions/*` always matches the API rather than being rewritten to `index.html`. None
of the routes require authentication — deck itself enforces no auth challenge on any route;
the only refusals below are the capability and declaration gates.

Pre-run refusal codes (a non-2xx JSON body, never a stream):

| Code | HTTP status | Cause |
|---|---|---|
| `ACTIONS_DISABLED` | 403 | The capability is off, or absent from this deployment |
| `ACTION_UNKNOWN` | 404 | No action with that id is declared in config |
| `RUNNER_UNRESOLVED` | 422 | The action's declared runner name isn't in the manifest |
| `PARAMS_INVALID` | 400 | Submitted parameters failed validation (`paramErrors` included) |

## Configuration

Four environment variables control the capability, read once at boot:

| Variable | Required when enabled | Default | Meaning |
|---|---|---|---|
| `DECK_ACTIONS_ENABLED` | — | `false` | Master switch. `"true"`/`"1"` (case-insensitive) enables; anything else is off |
| `DECK_ACTION_TIMEOUT_MS` | no | `600000` (10 min) | Default max run duration in ms. If set, must be a positive integer — a malformed value fails boot rather than silently falling back |
| `DECK_DATA_DIR` | yes | — | Module data root (absolute); the audit store is `$DECK_DATA_DIR/actions` |
| `DECK_RUNNERS_FILE` | yes | — | Path to the runner manifest (see below) |

```bash
DECK_ACTIONS_ENABLED=true \
DECK_DATA_DIR=/var/lib/deck \
DECK_RUNNERS_FILE=/etc/deck/runners.json \
  bun apps/server/src/server/boot.ts
```

**Fail-fast posture.** When the capability is enabled but `DECK_DATA_DIR` or
`DECK_RUNNERS_FILE` is missing, or `DECK_ACTION_TIMEOUT_MS` isn't a positive integer,
or the runner manifest fails validation, the module's init fails and boot writes a
plain-text error to stderr (`module "actions" failed to initialise: …`) and exits 2 — the
same posture as a bad estate config. Deck will not start a half-configured
write path. When the capability is disabled, none of this is required or read.

## Runner manifest

The manifest is a JSON object provisioned by the operator, outside deck's own code,
mapping a runner **name** to the **absolute path** of an executable on the host:

```json
{
  "restart-nginx": "/usr/local/bin/deck-runners/restart-nginx.sh",
  "backup-db": "/usr/local/bin/deck-runners/backup-db.sh"
}
```

Deck loads it once at boot into an immutable allowlist and only ever looks names up as
map keys — a declared action's `runner` name is never used to construct a filesystem
path, so path traversal is structurally impossible. Validation runs once at boot and
any failure aborts startup:

1. The file must be readable.
2. Its content must be valid JSON.
3. The root must be a plain object of string keys to string values.
4. Every value must be an **absolute** path — a relative path is rejected.
5. Every value must point at an existing regular file.

At invoke time, deck passes the action's declared id and resolved parameters as a
single JSON document on the runner's **stdin** — never as interpolated argv — and tees
the runner's stdout/stderr both to the live NDJSON stream and to the audit log.

## Execution lifecycle

Every invocation resolves to exactly one outcome, recorded in exactly one audit entry:

| Outcome | Meaning |
|---|---|
| `succeeded` | Runner spawned and exited 0 |
| `failed` | Runner spawned and exited non-zero |
| `error` | Runner unreachable, not installed, or failed to start (spawn itself threw) |
| `rejected` | Refused pre-run: capability disabled, undeclared id, unknown runner, invalid params |
| `timed-out` | Exceeded `DECK_ACTION_TIMEOUT_MS` — child killed |
| `cancelled` | Operator cancelled — child killed |

The executor holds an in-memory `Map<runId, RunHandle>` registry. A run is registered
— and its `run` event pushed onto the NDJSON stream — *before* the child is spawned,
so a cancel request can find the run the instant the client learns its `runId`. If a
cancel (or timeout) arrives before the spawn call runs, the pre-spawn abort check
short-circuits: the child is never started and the run still resolves to a normal
terminal outcome.

**Cancellation.** `POST /api/actions/runs/:runId/cancel` looks the id up in the
registry: `202` and a `SIGTERM` to the child if found, `404` for an unknown or
already-finished run. The terminal `cancelled` outcome still arrives asynchronously
through the run's own `end` event — the cancel response does not carry it.

**Timeout.** The executor arms a timer for `DECK_ACTION_TIMEOUT_MS` (default 10
minutes) when the child spawns, using the same `AbortController` + `clearTimeout`
idiom as the provider registry. Expiry aborts the run's controller, which rejects the
exit-wait promise and kills the child with `SIGTERM`; the outcome becomes `timed-out`
unless a `cancel()` call already claimed the abort first.

**Killing a run.** Each runner is spawned as the leader of its own process group, and a
cancel or timeout signals the whole group. That covers anything the runner started
locally, which may hold its output pipes open. The group gets `SIGTERM`, then `SIGKILL`
if the runner has not exited within 1 s. Once it has exited, its pipes get 500 ms to drain
before the run is recorded, so a lingering descendant can never stop the audit entry being
written.

**Shutdown.** When deck stops, it cancels every in-flight run (`cancelAll()`) and waits,
within a bound, until each has been audited as `cancelled`.

**Disconnect decoupling.** The run is driven independently of whoever is reading its
event stream. A client that stops reading (tab closed, network drop) does not abort
anything — the child keeps running, its output keeps being teed to the per-run log,
and the terminal audit entry is still appended when it finishes. There is no
supervisor-level concurrency cap: each run is registered and driven independently.

Every code path through the drive loop — success, spawn failure, timeout, cancel, or
an unexpected internal throw — passes through one `finally` block that always emits
the terminal `end` wire event and always appends the audit entry, so the UI never
hangs and no run goes unrecorded. An audit-append failure at that point is logged
through the existing structured logger rather than escaping as an unhandled
rejection; the `end` event has already reached the client by then either way.

## Audit store

A two-tier, append-only store rooted at `DECK_DATA_DIR/actions/`:

```
<DECK_DATA_DIR>/actions/
  audit.jsonl          # compact index: one JSON object per line, one per run
  runs/
    <runId>.log         # full captured stdout+stderr for that run
```

- **Index (`audit.jsonl`):** every run — including a pre-run refusal — appends exactly
  one line via a single atomic `O_APPEND` write, opened `0o644`. Parameters are
  recorded **unredacted**. Every entry carries the runner **name**, never its resolved
  path.
- **Per-run output (`runs/<runId>.log`):** the full captured stdout/stderr for runs
  that reached execution; absent for pre-run refusals.
- **Append-only, no rotation:** neither file is rotated or pruned by deck itself.
- **Robust reads:** a truncated final line in the index is dropped silently; a corrupt
  interior line is skipped with a warning (when a logger was supplied) and the rest of
  the index stays readable; a genuine filesystem error (e.g. the index becoming
  unreadable) throws rather than returning an empty result.

## Web UI

The Actions page (`apps/web/src/features/governed-actions/`) is a standalone SPA
route at `/actions` — no dashboard cards, no entity-detail fragments, no shell edits.
It composes five presentational components around one singleton run store.

**Page assembly.** `ActionsPage` wraps its content in a page-owned class error
boundary (isolated from the shell, so a display failure here never blanks
navigation) and branches exhaustively on config load state. Once ready, the page
owns local UI state — the selected action, the per-parameter value map, and the
confirm-arm state (`clickArmed` / `typedValue`) — all reset together whenever the
operator selects a different action, so an armed confirmation never leaks across
actions. Parameter values are re-validated on every render through the same
`validateActionParams` function the server uses for its authoritative gate, so
client-side feedback can never diverge from server behavior. If a server response
ever disagrees with the client (e.g. a config default changed between page load and
invoke), its `PARAMS_INVALID` field errors are merged into the same error list the
form already shows.

**Capability-disabled posture.** The page carries no separate "is this enabled" check
at load; it discovers the capability is off only when a run is refused with
`ACTIONS_DISABLED`, and then switches permanently into a read-only view — the action
list stays visible (disabled) alongside the audit history, but no parameter form or
confirm step mounts.

**Confirm modes.** Each action declares one of three confirm modes, resolved by the
pure `isRunArmed` predicate:

| Mode | Armed when |
|---|---|
| `none` | Always — the Run control still requires valid params |
| `confirm` | The operator has clicked a separate "Arm run" control |
| `typed-confirm` | The operator has typed the action's id exactly |

Before a run is armed in `confirm`/`typed-confirm` mode, a "declared intent" panel
shows the action's title, description, runner **name**, target (if any), and
resolved parameter values as plain text — never a synthesized shell command, since
deck itself has no shell command to show.

**Streaming client** (`client.ts`) owns all HTTP for the feature. `invokeAction`
POSTs the raw parameter map and reads the response body as NDJSON: native
`EventSource` isn't used because it's GET-only and invocation is a POST. The reader
decodes UTF-8 incrementally, splits on newlines, buffers a trailing partial line
across chunks, and JSON-parses each complete line into a wire event; a malformed
line is skipped rather than throwing (the terminal `end` event is the authority on
completion). Every failure mode — a non-2xx refusal body, a body-less response, or a
stream that drops mid-read — resolves to a visible terminal state rather than an
unhandled rejection or a hung UI; the server-side run is unaffected and remains
visible in the audit history regardless of what happens to the client stream.

**Run store** (`run-store.ts`) is a module-singleton, mirroring the pattern used by
`drift-and-coverage`: one frozen `RunState` value (`idle → requesting → streaming →
terminal`) replaced atomically by the client's event handlers, a `Set` of listener
records notified from a stable snapshot (one throwing listener never blocks the
rest), and a `useRun()` hook that subscribes a component and re-reads once after
subscribing to close the render/effect race. Every surface on the page — `ParamForm`,
`ConfirmStep`, `RunOutput` — reads from this one store; there is no per-component
polling or duplicate state.

**Audit history** (`AuditHistory.tsx`) is read-only and loads its list once on mount
(no automatic refresh after a run completes); selecting a row fetches that entry's
full detail, including unredacted parameters and captured output.

**Keyboard handling** (`keyboard.ts`) is pure and DOM-free: `Escape` resolves to
`cancel` (abandon the confirm step, close an open audit detail), `Enter` resolves to
`submit` (activate an armed run, open a focused audit row), and any Ctrl/Meta chord
resolves to `none` so native browser shortcuts are never hijacked. The mounted
component still owns filtering by event target and by armed state — the resolver
never touches the DOM or reads live run state itself.
