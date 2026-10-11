#!/usr/bin/env bash
# Fixture smoke-echo runner (governed-actions smoke path).
#
# The smoke boot maps the `smoke-echo` runner name to this script. It consumes
# the StructuredRunnerInput JSON on stdin, echoes a line to stdout, and exits 0
# so POST /api/actions/smoke-echo streams a terminal end/succeeded event via the
# real Bun spawner and real audit write.
set -euo pipefail
input="$(cat)"
printf 'smoke-echo: ok (%s bytes in)\n' "${#input}"
exit 0
