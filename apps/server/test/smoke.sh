#!/usr/bin/env bash
#
# Project smoke path (governed-actions extended it — spec 06 §7).
#
# Proves three things end-to-end against a real Bun server:
#   1. Portal read path boots and serves a provider GET (the original smoke).
#   2. With actions ENABLED, POST /api/actions/smoke-echo streams a real run to a
#      terminal end/succeeded event (real Bun spawn + real audit write; SC-01/05).
#   3. With actions DISABLED (default), the same POST refuses 403 ACTIONS_DISABLED
#      (safe-by-default read-only posture; SC-08).
#   4. Sources read path serves a fixture markdown tree with confinement intact.
#   5. With DECK_METRICS_ENABLED=true, GET /metrics serves Prometheus text; the
#      default (off) returns 404.
#
# It runs one server at a time, on distinct ports, cleaning each up before the
# next. Any failed assertion exits non-zero so impl-verify treats it as a failure.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
BOOT="${REPO_ROOT}/apps/server/src/server/boot.ts"
RUNNERS_DIR="${SCRIPT_DIR}/fixtures/actions-runners"
SMOKE_CONFIG="${SCRIPT_DIR}/fixtures/actions-smoke"
PORTAL_CONFIG="${SCRIPT_DIR}/fixtures/portal-estate"
SOURCES_FIXTURE="${SCRIPT_DIR}/fixtures/markdown-tree"

PORTAL_PORT=8788
ACTIONS_PORT=8789
SOURCES_PORT=8790
METRICS_PORT=8791

TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/deck-smoke.XXXXXX")"
DATA_DIR="${TMP_ROOT}/data"
RUNNERS_FILE="${TMP_ROOT}/runners.json"
SOURCES_CONFIG_DIR="${TMP_ROOT}/sources-config"
SOURCES_CACHE_DIR="${TMP_ROOT}/sources-cache"
mkdir -p "${DATA_DIR}" "${SOURCES_CONFIG_DIR}" "${SOURCES_CACHE_DIR}"

SRV=""
cleanup() {
  if [ -n "${SRV}" ]; then
    kill "${SRV}" 2>/dev/null || true
    wait "${SRV}" 2>/dev/null || true
  fi
  rm -rf "${TMP_ROOT}" 2>/dev/null || true
}
trap cleanup EXIT

fail() {
  printf 'SMOKE FAIL: %s\n' "$1" >&2
  exit 1
}

# Wait until $1 (a URL) returns any HTTP status, or the server PID dies.
wait_ready() {
  local url="$1" i status
  for i in $(seq 1 40); do
    status="$(curl -sS -o /dev/null -w '%{http_code}' "${url}" 2>/dev/null)" || status=000
    if [ "${status}" != "000" ]; then
      return 0
    fi
    kill -0 "${SRV}" 2>/dev/null || return 1
    sleep 0.25
  done
  return 1
}

stop_server() {
  if [ -n "${SRV}" ]; then
    kill "${SRV}" 2>/dev/null || true
    wait "${SRV}" 2>/dev/null || true
    SRV=""
  fi
}

# Write the runner manifest with absolute script paths (loadRunners requires
# absolute, existing files). Values are the committed fixture runner scripts.
cat >"${RUNNERS_FILE}" <<EOF
{
  "smoke-echo": "${RUNNERS_DIR}/smoke-echo.sh"
}
EOF

# ---------------------------------------------------------------------------
# 1. Portal read path (original smoke): provider GET returns 200.
# ---------------------------------------------------------------------------
DECK_CONFIG_DIR="${PORTAL_CONFIG}" DECK_PORT="${PORTAL_PORT}" bun "${BOOT}" &
SRV=$!
wait_ready "http://127.0.0.1:${PORTAL_PORT}/api/providers/docker" \
  || fail "portal server did not become ready"
STATUS="$(curl -sS -o /dev/null -w '%{http_code}' \
  "http://127.0.0.1:${PORTAL_PORT}/api/providers/docker")" || STATUS=000
[ "${STATUS}" = "200" ] || fail "portal provider GET expected 200, got ${STATUS}"
stop_server

# ---------------------------------------------------------------------------
# 2. Actions ENABLED: POST /api/actions/smoke-echo streams end/succeeded.
# ---------------------------------------------------------------------------
DECK_ACTIONS_ENABLED=true \
DECK_RUNNERS_FILE="${RUNNERS_FILE}" \
DECK_DATA_DIR="${DATA_DIR}" \
DECK_CONFIG_DIR="${SMOKE_CONFIG}" \
DECK_PORT="${ACTIONS_PORT}" bun "${BOOT}" &
SRV=$!
wait_ready "http://127.0.0.1:${ACTIONS_PORT}/api/config" \
  || fail "actions-enabled server did not become ready"

HEADERS="${TMP_ROOT}/enabled.headers"
BODY="${TMP_ROOT}/enabled.body"
CODE="$(curl -sS -X POST \
  -H 'content-type: application/json' -d '{}' \
  -D "${HEADERS}" -o "${BODY}" -w '%{http_code}' \
  "http://127.0.0.1:${ACTIONS_PORT}/api/actions/smoke-echo")" || CODE=000
[ "${CODE}" = "200" ] || fail "enabled POST expected 200, got ${CODE}"
grep -qi 'content-type: *application/x-ndjson' "${HEADERS}" \
  || fail "enabled POST expected application/x-ndjson content type"
LAST_LINE="$(grep -v '^[[:space:]]*$' "${BODY}" | tail -n 1)"
case "${LAST_LINE}" in
  *'"type":"end"'*'"outcome":"succeeded"'*) : ;;
  *) fail "enabled POST stream did not end in end/succeeded: ${LAST_LINE}" ;;
esac

# The terminal `end` event is emitted before the audit entry is appended, so poll
# a few times rather than asserting once (mirrors wait_ready's retry loop).
AUDIT_OK=""
for i in $(seq 1 20); do
  AUDIT_BODY="$(curl -sS "http://127.0.0.1:${ACTIONS_PORT}/api/actions/audit")" || AUDIT_BODY=""
  case "${AUDIT_BODY}" in
    *'"actionId":"smoke-echo"'*'"outcome":"succeeded"'*) AUDIT_OK=1; break ;;
  esac
  sleep 0.25
done
[ -n "${AUDIT_OK}" ] \
  || fail "audit index missing the succeeded smoke-echo run: ${AUDIT_BODY}"
stop_server

# ---------------------------------------------------------------------------
# 3. Actions DISABLED (default): POST refuses 403 ACTIONS_DISABLED.
# ---------------------------------------------------------------------------
DECK_CONFIG_DIR="${SMOKE_CONFIG}" DECK_PORT="${ACTIONS_PORT}" bun "${BOOT}" &
SRV=$!
wait_ready "http://127.0.0.1:${ACTIONS_PORT}/api/config" \
  || fail "actions-disabled server did not become ready"

DBODY="${TMP_ROOT}/disabled.body"
DCODE="$(curl -sS -X POST \
  -H 'content-type: application/json' -d '{}' \
  -o "${DBODY}" -w '%{http_code}' \
  "http://127.0.0.1:${ACTIONS_PORT}/api/actions/smoke-echo")" || DCODE=000
[ "${DCODE}" = "403" ] || fail "disabled POST expected 403, got ${DCODE}"
grep -q 'ACTIONS_DISABLED' "${DBODY}" \
  || fail "disabled POST expected ACTIONS_DISABLED code, got: $(cat "${DBODY}")"
stop_server

# ---------------------------------------------------------------------------
# 4. Sources read path: boot a fixture local-path markdown-tree source and prove
#    the confined read path end to end (no git, no network — spec 08 §7).
# ---------------------------------------------------------------------------
# Write a config declaring the committed markdown-tree fixture as a local-path
# source. JSON is valid YAML and the loader reads *.yaml, so an absolute path is
# injected at runtime (the committed fixture path differs per machine). `sources`
# is an overlay-owned key, so it lives in a second layer ("zzz-sources.yaml" sorts
# after the base "estate.yaml") — not the base — mirroring the actions overlay.
cat >"${SOURCES_CONFIG_DIR}/estate.yaml" <<EOF
{ "schemaVersion": 1, "estate": { "name": "Sources smoke" } }
EOF
cat >"${SOURCES_CONFIG_DIR}/zzz-sources.yaml" <<EOF
{
  "schemaVersion": 1,
  "sources": [
    { "id": "docs", "kind": "markdown-tree", "title": "Docs", "location": { "path": "${SOURCES_FIXTURE}" } }
  ]
}
EOF

DECK_CONFIG_DIR="${SOURCES_CONFIG_DIR}" \
DECK_SOURCES_CACHE_DIR="${SOURCES_CACHE_DIR}" \
DECK_PORT="${SOURCES_PORT}" bun "${BOOT}" &
SRV=$!
wait_ready "http://127.0.0.1:${SOURCES_PORT}/api/config" \
  || fail "sources server did not become ready"

# 4a. The provider registered and produced a manifest — poll until data.tree lands
# (the first poll completes shortly after boot; mirrors the audit poll above).
PROVIDER_URL="http://127.0.0.1:${SOURCES_PORT}/api/providers/docs"
TREE_OK=""
for i in $(seq 1 40); do
  PSTATUS="$(curl -sS -o "${TMP_ROOT}/provider.body" -w '%{http_code}' "${PROVIDER_URL}")" || PSTATUS=000
  if [ "${PSTATUS}" = "200" ] && grep -q '"tree"' "${TMP_ROOT}/provider.body"; then
    TREE_OK=1
    break
  fi
  sleep 0.25
done
[ -n "${TREE_OK}" ] \
  || fail "sources provider GET expected 200 with data.tree, got ${PSTATUS}: $(cat "${TMP_ROOT}/provider.body" 2>/dev/null)"

# 4b. A fixture file is served end to end through the real confined reader.
FILE_BODY="${TMP_ROOT}/sources.file"
FCODE="$(curl -sS -o "${FILE_BODY}" -w '%{http_code}' \
  "http://127.0.0.1:${SOURCES_PORT}/api/sources/docs/file?path=index.md")" || FCODE=000
[ "${FCODE}" = "200" ] || fail "sources file GET expected 200, got ${FCODE}"
grep -q '"content"' "${FILE_BODY}" \
  || fail "sources file GET expected a content field, got: $(cat "${FILE_BODY}")"

# 4c. A traversal path is rejected (confinement spine holds in a real boot) with
# no leaked filesystem path in the body.
ESC_BODY="${TMP_ROOT}/sources.escape"
ECODE="$(curl -sS -o "${ESC_BODY}" -w '%{http_code}' \
  "http://127.0.0.1:${SOURCES_PORT}/api/sources/docs/file?path=../escape")" || ECODE=000
case "${ECODE}" in
  400|404) : ;;
  *) fail "sources traversal GET expected 400/404, got ${ECODE}: $(cat "${ESC_BODY}")" ;;
esac
grep -q '"code"' "${ESC_BODY}" \
  || fail "sources traversal reject expected a typed { error, code } body, got: $(cat "${ESC_BODY}")"
if grep -qF "${SOURCES_FIXTURE}" "${ESC_BODY}"; then
  fail "sources traversal reject leaked the source path in its body"
fi
stop_server

# ---------------------------------------------------------------------------
# 5. Metrics: DECK_METRICS_ENABLED=true serves Prometheus text at /metrics; the
#    default (off) leaves the route unregistered (404).
# ---------------------------------------------------------------------------
DECK_METRICS_ENABLED=true \
DECK_CONFIG_DIR="${PORTAL_CONFIG}" DECK_PORT="${METRICS_PORT}" bun "${BOOT}" &
SRV=$!
wait_ready "http://127.0.0.1:${METRICS_PORT}/api/config" \
  || fail "metrics-enabled server did not become ready"

MHEADERS="${TMP_ROOT}/metrics.headers"
MBODY="${TMP_ROOT}/metrics.body"
MCODE="$(curl -sS -D "${MHEADERS}" -o "${MBODY}" -w '%{http_code}' \
  "http://127.0.0.1:${METRICS_PORT}/metrics")" || MCODE=000
[ "${MCODE}" = "200" ] || fail "metrics GET expected 200, got ${MCODE}"
grep -qi 'content-type: *text/plain' "${MHEADERS}" \
  || fail "metrics GET expected text/plain content type"
grep -q '^# TYPE deck_provider_count gauge' "${MBODY}" \
  || fail "metrics body missing deck_provider_count: $(cat "${MBODY}")"
grep -q '^# TYPE deck_provider_poll_success_total counter' "${MBODY}" \
  || fail "metrics body missing deck_provider_poll_success_total"
stop_server

DECK_CONFIG_DIR="${PORTAL_CONFIG}" DECK_PORT="${METRICS_PORT}" bun "${BOOT}" &
SRV=$!
wait_ready "http://127.0.0.1:${METRICS_PORT}/api/config" \
  || fail "metrics-disabled server did not become ready"
MOFF="$(curl -sS -o /dev/null -w '%{http_code}' \
  "http://127.0.0.1:${METRICS_PORT}/metrics")" || MOFF=000
[ "${MOFF}" = "404" ] || fail "metrics GET with flag off expected 404, got ${MOFF}"
stop_server

printf 'SMOKE OK: portal GET 200; actions enabled end/succeeded; actions disabled 403 ACTIONS_DISABLED; sources manifest+file 200, traversal rejected; metrics 200 text/plain, off 404\n'
