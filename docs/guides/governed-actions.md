# Enable and define governed actions

Deck can run pre-declared, operator-provisioned write actions against your estate — restart a
service, run a maintenance script — and stream their output to the browser with an audit
trail.
The capability is off by default, so every read-only deployment stays read-only until you opt
in and provision a runner allowlist.

This guide is the how-to.
For why the subsystem is shaped this way — the capability gate, the allowlist, confirmation,
and audit — read [Governed actions](../architecture/governed-actions.md).
For the wider security posture, see [Security & access posture](../security.md).

## Enable the capability

Actions are gated by three environment variables set on the deck process:

```bash
export DECK_ACTIONS_ENABLED=true      # master switch ("true" or "1"); default is off
export DECK_DATA_DIR=/var/lib/deck    # directory for the append-only audit store
export DECK_RUNNERS_FILE=/etc/deck/runners.json   # the runner allowlist (see below)
```

An optional fourth variable bounds each run:

```bash
export DECK_ACTION_TIMEOUT_MS=600000  # default 600000 (10 minutes); positive integer
```

Until `DECK_ACTIONS_ENABLED` is truthy, every action write route refuses with HTTP `403` and
the code `ACTIONS_DISABLED`.
The capability probe `GET /api/actions` always answers `200` with `{ "enabled": false }` so
the UI can hide the action controls rather than provoke a 403.

When the capability is enabled, deck resolves this configuration once at boot and fails fast:
if `DECK_DATA_DIR` or `DECK_RUNNERS_FILE` is missing, the timeout is not a positive integer, or
the runner manifest is malformed, the process aborts instead of starting a half-configured
write path.

## Register a runner

Deck never runs a raw command from config.
An action names a *runner*, and the runner name is resolved to an executable through an
allowlist you provision outside deck — a JSON object mapping each name to an absolute
executable path — at the path named by `DECK_RUNNERS_FILE`:

```json
{
  "restart-service": "/opt/estate/runners/restart-service.sh",
  "backup-now": "/opt/estate/runners/backup-now.sh"
}
```

At boot deck validates the whole manifest and refuses to start on any problem: it must be
valid JSON, an object of string-to-string entries, every value an absolute path, and every
path an existing regular file.
Names are looked up as map keys — deck never builds a filesystem path from a name — so a
runner name can never be used to reach an executable that is not on the list.

## Author an action

Declare actions in your estate config under the top-level `actions` list.
Each action requires `id`, `title`, `runner`, and `confirm`; the `runner` must be a name from
your allowlist.

```yaml
actions:
  - id: restart-portal
    title: Restart portal
    runner: restart-service
    confirm: typed-confirm
    description: Restart the portal service on the apps host.
    target: { host: apps, service: portal }
    params:
      - name: reason
        type: string
        required: true
        description: Why the restart is being performed (recorded in the audit log).
      - name: mode
        type: enum
        values: [graceful, force]
        default: graceful
```

`confirm` sets the confirmation deck's UI requires before it will run the action, and takes one
of three levels:

- `none` — run immediately.
- `confirm` — a simple confirmation prompt.
- `typed-confirm` — the operator must type to confirm.

`confirm` is a client-side affordance: the web UI honors the level before it posts the run, but
the server does not require a confirmation token. A direct call to `POST /api/actions/:id` is
gated by the capability toggle, the runner allowlist, and parameter validation — not by
`confirm`. Treat it as an operator-facing safeguard, not a server-enforced guarantee.

Each entry in `params` requires a `name` and a `type` of `string`, `number`, `boolean`, or
`enum`.
Optional per-parameter fields are `required`, `default`, `values` (the allowed set for an
`enum`), and `description`.
The optional `target` records the host (and optional service) the action acts on.

When a run is triggered, deck validates the supplied parameters against these declarations
before spawning anything: it coerces each value to its declared type, enforces `required`,
applies defaults, rejects an `enum` value outside `values`, and drops any key the action did
not declare.
Invalid input is refused as a whole with per-parameter messages, so a bad value never reaches
the runner.

## Run and audit

Actions are triggered from the web UI, which honors the `confirm` level before it posts the
run.
The underlying routes are:

```text
POST /api/actions/:id                     # run an action (streams NDJSON output)
POST /api/actions/runs/:runId/cancel      # cancel an in-flight run
GET  /api/actions/audit                   # list past runs, newest first
GET  /api/actions/audit/:runId            # one run's entry plus its full output
```

A run is gated in order before it starts, each gate producing a distinct code: capability off
(`403 ACTIONS_DISABLED`), unknown action id (`404 ACTION_UNKNOWN`), a runner name not in the
allowlist (`422 RUNNER_UNRESOLVED`), and invalid parameters (`400 PARAMS_INVALID`).
On success the response streams the run's output as newline-delimited JSON.

A client disconnect does not cancel the run — the executor keeps running server-side and still
records the outcome.
To stop a run explicitly, post to the cancel route; it answers `202` when the run was
cancelled, or `404 RUN_NOT_FOUND` if no in-flight run has that id.

Every run is written to the audit store, including refusals (recorded with outcome
`rejected`), so the audit list is a complete history of what was attempted.
Each entry records the action id, runner, parameters, request origin, outcome, exit status,
duration, and output size; the detail route adds the run's full captured output.
