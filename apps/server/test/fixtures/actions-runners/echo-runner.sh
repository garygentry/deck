#!/usr/bin/env bash
# Fixture echo runner (governed-actions e2e/smoke).
#
# Consumes the StructuredRunnerInput JSON on stdin and emits a few stdout lines
# with small pauses so the executor produces multiple streamed stdout chunks
# before the terminal `end` (incrementality — SC-02), then exits 0 (succeeded).
set -euo pipefail
input="$(cat)"
printf 'echo runner: started\n'
sleep 0.15
printf 'echo runner: received %s bytes of input\n' "${#input}"
sleep 0.15
printf 'echo runner: done\n'
exit 0
