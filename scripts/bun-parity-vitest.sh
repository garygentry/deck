#!/usr/bin/env bash
# Run the current workspace's Vitest suite under Bun for the CI `bun-parity` job.
#
# `--bun` makes vitest's `#!/usr/bin/env node` shebang resolve to Bun; without it the tests run
# under Node. scripts/bun-parity-reporter.ts refuses a Node runtime and writes a run summary, and
# scripts/bun-parity-check-cli.ts then fails the step unless that summary shows a complete,
# passing run that executed at least one test. So a run that exits 0 without reaching its end,
# leaves test files unfinished, or only skips tests still fails the job.
set -uo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
summary_dir="$(mktemp -d)"
trap 'rm -rf "$summary_dir"' EXIT
summary="$summary_dir/summary.json"

reporters=(--reporter=default --reporter="$root/scripts/bun-parity-reporter.ts")
# Failures also show as annotations on the GitHub run and PR.
if [[ "${GITHUB_ACTIONS:-}" == "true" ]]; then reporters+=(--reporter=github-actions); fi

status=0
DECK_BUN_PARITY_SUMMARY="$summary" bunx --bun vitest run "${reporters[@]}" "$@" || status=$?
bun "$root/scripts/bun-parity-check-cli.ts" "$summary" || { [[ $status -ne 0 ]] || status=1; }
exit "$status"
