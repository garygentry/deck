#!/bin/sh
# Claude Code statusLine hook that forwards each statusLine payload to deck's LLM usage
# ingest route, then prints a short status line.
#
# Install it as the statusLine command in ~/.claude/settings.json:
#   "statusLine": { "type": "command", "command": "/path/to/statusline-ingest.sh" }
#
# Environment:
#   DECK_URL                          deck's base URL; use https:// outside a trusted LAN
#   DECK_LLM_USAGE_INGEST_TOKEN_FILE  file holding the bearer token (preferred; chmod 600)
#   DECK_LLM_USAGE_INGEST_TOKEN       the token itself (fallback; every process Claude
#                                     Code starts inherits it)
# The token is the value deck reads from the env var named by
# llmUsage.claude.statusLine.credentialEnv.
#
# The POST runs detached in the background with a short timeout and its own stdio, so a
# slow or unreachable deck never delays the status line. The token travels in a header
# read from stdin and the payload from a private temp file, so neither appears in the
# process list.

payload=$(cat)

token=
if [ -n "${DECK_LLM_USAGE_INGEST_TOKEN_FILE:-}" ] && [ -r "$DECK_LLM_USAGE_INGEST_TOKEN_FILE" ]; then
  token=$(tr -d '\r\n' < "$DECK_LLM_USAGE_INGEST_TOKEN_FILE")
elif [ -n "${DECK_LLM_USAGE_INGEST_TOKEN:-}" ]; then
  token=$DECK_LLM_USAGE_INGEST_TOKEN
fi

if [ -n "${DECK_URL:-}" ] && [ -n "$token" ] && command -v curl >/dev/null 2>&1; then
  body=$(umask 077 && mktemp) && printf '%s' "$payload" > "$body" && (
    printf 'Authorization: Bearer %s\n' "$token" |
      curl -fsS --max-time 3 -o /dev/null \
        -H @- -H 'Content-Type: application/json' \
        --data-binary "@$body" \
        "${DECK_URL%/}/api/llm-usage/ingest"
    rm -f "$body"
  ) </dev/null >/dev/null 2>&1 &
fi

# The status line itself: model and current-session usage, when jq is available.
if command -v jq >/dev/null 2>&1; then
  printf '%s' "$payload" | jq -r '
    [ .model.display_name // empty,
      ( .rate_limits.five_hour
        | (.utilization // .used_percentage)
        | select(. != null)
        | "session \(. | floor)%" ) ]
    | join(" · ")' 2>/dev/null || printf 'Claude\n'
else
  printf 'Claude\n'
fi
exit 0
