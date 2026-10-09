#!/usr/bin/env bash
# Run the current workspace's Vitest suite under Bun for the CI `bun-parity` job.
#
# `--bun` makes vitest's `#!/usr/bin/env node` shebang resolve to Bun; without it the tests run
# under Node. scripts/bun-parity-reporter.ts refuses a Node runtime and writes a run summary;
# this script then fails unless that summary exists and counts at least one test, so a run that
# exits 0 without reaching its end still fails the job.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
summary_dir="$(mktemp -d)"
trap 'rm -rf "$summary_dir"' EXIT
summary="$summary_dir/summary.json"

DECK_BUN_PARITY_SUMMARY="$summary" bunx --bun vitest run \
  --reporter=default --reporter="$root/scripts/bun-parity-reporter.ts" "$@"

if [[ ! -s "$summary" ]]; then
  echo "bun-parity: vitest exited 0 but never reached the end of its run (no summary written)" >&2
  exit 1
fi
echo "bun-parity: summary $(cat "$summary")"
bun -e '
  const s = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  if (!s.bun) { console.error("bun-parity: the run did not report a Bun runtime"); process.exit(1); }
  if (s.tests < 1) { console.error("bun-parity: the run collected no tests"); process.exit(1); }
' "$summary"
