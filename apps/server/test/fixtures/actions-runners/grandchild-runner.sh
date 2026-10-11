#!/usr/bin/env bash
# Fixture runner whose child outlives it (shutdown tests).
#
# Starts `sleep` in the background WITHOUT `exec`: the sleep inherits the stdout pipe, so
# killing only this shell would leave the pipe open and the run's output never at EOF.
# deck must kill the runner's whole process group and still audit the run.
set -uo pipefail
cat >/dev/null
sleep 120 &
printf 'grandchild %s\n' "$!"
wait
