#!/usr/bin/env bash
# Fixture long-running runner (governed-actions e2e/smoke).
#
# Emits an initial stdout line so the client observes live output, then sleeps
# long enough to be cancelled or time out. deck kills the local child on
# cancel/timeout (REQ-LIFE-01/02/03); the sleep dies with it.
set -uo pipefail
cat >/dev/null
printf 'long runner: started, now waiting\n'
# `exec` so the sleep REPLACES the shell (same PID deck tracks). Otherwise a
# killed shell would orphan `sleep`, and the orphan inheriting the stdout pipe
# would keep it open — the executor would never see EOF and the terminal `end`
# would be delayed until the sleep finally exits.
exec sleep 120
