#!/bin/sh
# Deck container entrypoint.
#
# Serves the built web app (DECK_WEB_DIST) plus the /api server from a single
# Bun process. The estate config is expected on a mounted volume at
# DECK_CONFIG_DIR (default /config). Every DECK_* env the server reads
# (DECK_PORT, DECK_SNAPSHOT_SOURCE, DECK_SOURCES_*, actions envs, ...) passes
# straight through — this script only supplies container-sensible defaults and
# the one convenience below.
set -eu

: "${DECK_CONFIG_DIR:=/config}"
: "${DECK_WEB_DIST:=/app/apps/web/dist}"
: "${DECK_PORT:=8080}"
export DECK_CONFIG_DIR DECK_WEB_DIST DECK_PORT

# Convenience for estates that ship a snapshot template (like examples/estate):
# if no snapshot source was supplied, materialize one with now-relative
# timestamps into a writable runtime dir so freshness renders correctly.
# Operators pointing DECK_SNAPSHOT_SOURCE at a real snapshot skip this entirely.
if [ -z "${DECK_SNAPSHOT_SOURCE:-}" ] && [ -f "${DECK_CONFIG_DIR}/snapshot.template.json" ]; then
  snapshot_out="${DECK_SNAPSHOT_OUT:-/tmp/deck/snapshot.json}"
  bun /app/scripts/make-example-snapshot.mjs \
    --template "${DECK_CONFIG_DIR}/snapshot.template.json" \
    --out "${snapshot_out}"
  export DECK_SNAPSHOT_SOURCE="${snapshot_out}"
fi

exec bun /app/apps/server/src/server/boot.ts
