#!/usr/bin/env bash
# Fixture non-zero-exit runner (governed-actions e2e/smoke).
#
# Consumes stdin, writes to stdout and stderr, then exits non-zero so the
# executor reports outcome "failed" with the child's exit code (REQ-FAIL-03).
set -uo pipefail
cat >/dev/null
printf 'nonzero runner: about to fail\n'
printf 'nonzero runner: failure detail on stderr\n' >&2
exit 3
