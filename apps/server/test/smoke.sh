#!/usr/bin/env bash
#
# Project smoke path.
#
# Proves three things end-to-end against a real Bun server:
#   1. Portal read path boots and serves a provider GET (the original smoke).
#   2. With actions ENABLED, POST /api/actions/smoke-echo streams a real run to a
#      terminal end/succeeded event (real Bun spawn + real audit write).
#   3. With actions DISABLED (default), the same POST refuses 403 ACTIONS_DISABLED
#      (safe-by-default read-only posture).
#   4. Sources read path serves a fixture markdown tree with confinement intact.
#   5. With DECK_METRICS_ENABLED=true, GET /metrics serves Prometheus text; the
#      default (off) returns 404.
#   6. ui hot reload follows a Kubernetes ConfigMap ..data swap.
#   7. A runtime module from DECK_MODULES_DIR adds a page, a pill and a provider.
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

# Four consecutive ports from DECK_SMOKE_BASE_PORT (default 8788), so parallel checkouts can
# run the smoke without colliding.
SMOKE_BASE_PORT="${DECK_SMOKE_BASE_PORT:-8788}"
PORTAL_PORT=$((SMOKE_BASE_PORT))
ACTIONS_PORT=$((SMOKE_BASE_PORT + 1))
SOURCES_PORT=$((SMOKE_BASE_PORT + 2))
METRICS_PORT=$((SMOKE_BASE_PORT + 3))

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
#    the confined read path end to end (no git, no network).
# ---------------------------------------------------------------------------
# Write a config declaring the committed markdown-tree fixture as a local-path
# source. JSON is valid YAML and the loader reads *.yaml, so an absolute path is
# injected at runtime (the committed fixture path differs per machine). `sources`
# is an overlay-owned key, so it lives in a second layer ("zzz-sources.yaml" sorts
# after the base "estate.yaml") — not the base — mirroring the actions overlay.
cat >"${SOURCES_CONFIG_DIR}/estate.yaml" <<EOF
{ "schemaVersion": 2, "estate": { "name": "Sources smoke" } }
EOF
cat >"${SOURCES_CONFIG_DIR}/zzz-sources.yaml" <<EOF
{
  "schemaVersion": 2,
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

# ---------------------------------------------------------------------------
# 6. ui hot reload under Bun from a Kubernetes ConfigMap layout: files linked
#    through a `..data` symlink that is re-pointed atomically. Bun raises no
#    file-system event for that, so the reload comes from the watch's periodic
#    fingerprint of the config files (seen within about 5 s).
# ---------------------------------------------------------------------------
CM_DIR="${TMP_ROOT}/configmap"
mkdir -p "${CM_DIR}/..v1" "${CM_DIR}/..v2"
for v in v1 v2; do
  printf 'schemaVersion: 2\nestate:\n  name: smoke\n' >"${CM_DIR}/..${v}/00-base.yaml"
done
printf 'schemaVersion: 2\nui:\n  brand:\n    title: Before swap\n' >"${CM_DIR}/..v1/10-overlay.yaml"
printf 'schemaVersion: 2\nui:\n  brand:\n    title: After swap\n' >"${CM_DIR}/..v2/10-overlay.yaml"
ln -s ..v1 "${CM_DIR}/..data"
ln -s ..data/00-base.yaml "${CM_DIR}/00-base.yaml"
ln -s ..data/10-overlay.yaml "${CM_DIR}/10-overlay.yaml"

DECK_CONFIG_DIR="${CM_DIR}" DECK_PORT="${PORTAL_PORT}" bun "${BOOT}" &
SRV=$!
wait_ready "http://127.0.0.1:${PORTAL_PORT}/api/ui" \
  || fail "configmap server did not become ready"
curl -sS "http://127.0.0.1:${PORTAL_PORT}/api/ui" | grep -q '"title":"Before swap"' \
  || fail "configmap server did not serve the first version's brand"
# Past the boot-time re-read, so only the watch can see the swap.
sleep 1
ln -s ..v2 "${CM_DIR}/..data_tmp"
mv -T "${CM_DIR}/..data_tmp" "${CM_DIR}/..data"
SWAPPED=""
for i in $(seq 1 40); do
  if curl -sS "http://127.0.0.1:${PORTAL_PORT}/api/ui" 2>/dev/null | grep -q '"title":"After swap"'; then
    SWAPPED=1
    break
  fi
  sleep 0.25
done
[ -n "${SWAPPED}" ] || fail "configmap ..data swap was not reloaded within 10 s"
stop_server

# ---------------------------------------------------------------------------
# 7. A runtime module under Bun: the maintenance example, copied into a
#    DECK_MODULES_DIR of its own and imported from there, adds its page and
#    pill to /api/ui and serves its provider and its web half
#    (/modules/<id>/web.js; anything else there is a 404). With
#    DECK_MODULES_ENABLED unset, the same module is listed off and its web half
#    404s.
# ---------------------------------------------------------------------------
RT_MODULES_DIR="${TMP_ROOT}/runtime-modules"
mkdir -p "${RT_MODULES_DIR}"
cp -R "${REPO_ROOT}/examples/modules/maintenance" "${RT_MODULES_DIR}/maintenance"
RT_CONFIG_DIR="${TMP_ROOT}/runtime-config"
mkdir -p "${RT_CONFIG_DIR}"
printf 'schemaVersion: 2\nestate:\n  name: smoke\n' >"${RT_CONFIG_DIR}/00-base.yaml"
printf 'schemaVersion: 2\nmodules:\n  maintenance:\n    windows:\n      - name: smoke\n        start: 2999-01-01T00:00:00Z\n        durationMinutes: 5\n' \
  >"${RT_CONFIG_DIR}/10-overlay.yaml"

DECK_MODULES_DIR="${RT_MODULES_DIR}" DECK_MODULES_ENABLED=true \
DECK_CONFIG_DIR="${RT_CONFIG_DIR}" DECK_PORT="${PORTAL_PORT}" bun "${BOOT}" &
SRV=$!
wait_ready "http://127.0.0.1:${PORTAL_PORT}/api/ui" \
  || fail "runtime-module server did not become ready"
RT_UI="$(curl -sS "http://127.0.0.1:${PORTAL_PORT}/api/ui")"
printf '%s' "${RT_UI}" | grep -q '"id":"page:maintenance/windows"' \
  || fail "runtime module page missing from /api/ui"
printf '%s' "${RT_UI}" | grep -q '"id":"pill:maintenance/next"' \
  || fail "runtime module pill missing from /api/ui"
RT_DATA=""
for i in $(seq 1 40); do
  if curl -sS "http://127.0.0.1:${PORTAL_PORT}/api/providers/maintenance" 2>/dev/null | grep -q '"name":"smoke"'; then
    RT_DATA=1
    break
  fi
  sleep 0.25
done
[ -n "${RT_DATA}" ] || fail "runtime module provider did not serve its data"
printf '%s' "${RT_UI}" | grep -q '"web":{"script":"/modules/maintenance/web.js"' \
  || fail "runtime module web half missing from /api/ui"
RT_WEB_TYPE="$(curl -sS -o /dev/null -w '%{http_code} %{content_type}' \
  "http://127.0.0.1:${PORTAL_PORT}/modules/maintenance/web.js")" || RT_WEB_TYPE=000
case "${RT_WEB_TYPE}" in
  "200 text/javascript"*) ;;
  *) fail "runtime module web.js expected 200 text/javascript, got ${RT_WEB_TYPE}" ;;
esac
for RT_PATH in /modules/maintenance/server.mjs /modules/maintenance/missing.js /modules; do
  RT_CODE="$(curl -sS -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORTAL_PORT}${RT_PATH}")" || RT_CODE=000
  [ "${RT_CODE}" = "404" ] || fail "${RT_PATH} expected 404, got ${RT_CODE}"
done
stop_server

DECK_MODULES_DIR="${RT_MODULES_DIR}" \
DECK_CONFIG_DIR="${RT_CONFIG_DIR}" DECK_PORT="${PORTAL_PORT}" bun "${BOOT}" &
SRV=$!
wait_ready "http://127.0.0.1:${PORTAL_PORT}/api/ui" \
  || fail "runtime-modules-off server did not become ready"
curl -sS "http://127.0.0.1:${PORTAL_PORT}/api/ui" | grep -q '"reason":"not enabled: DECK_MODULES_ENABLED is not true"' \
  || fail "runtime module not reported off with DECK_MODULES_ENABLED unset"
RT_OFF="$(curl -sS -o /dev/null -w '%{http_code}' \
  "http://127.0.0.1:${PORTAL_PORT}/api/providers/maintenance")" || RT_OFF=000
[ "${RT_OFF}" = "404" ] || fail "runtime module provider with modules off expected 404, got ${RT_OFF}"
RT_OFF="$(curl -sS -o /dev/null -w '%{http_code}' \
  "http://127.0.0.1:${PORTAL_PORT}/modules/maintenance/web.js")" || RT_OFF=000
[ "${RT_OFF}" = "404" ] || fail "runtime module web.js with modules off expected 404, got ${RT_OFF}"
stop_server

printf 'SMOKE OK: portal GET 200; actions enabled end/succeeded; actions disabled 403 ACTIONS_DISABLED; sources manifest+file 200, traversal rejected; metrics 200 text/plain, off 404; configmap ..data swap reloaded under Bun; runtime module page+pill+provider, off when not enabled\n'
