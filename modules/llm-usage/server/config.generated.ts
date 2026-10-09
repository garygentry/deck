/* GENERATED from modules/llm-usage/schema.json by apps/server/src/scripts/gen-module-types.ts — do not edit; run `pnpm gen:module-types`. */

/**
 * Settings of the llm-usage module, at modules.llm-usage: subscription plan-usage limits for Claude Code and Codex accounts.
 */
export interface LlmUsage {
/**
 * Claude Code (Claude.ai Pro/Max) usage; presence enables the Claude panel.
 */
claude?: {
/**
 * Read-only path to a Claude Code .credentials.json; enables the OAuth usage backfill. Never written or refreshed by deck.
 */
credentialsFile?: string
/**
 * Optional read-only path to a Claude Code projects directory for the token-count transcript scan.
 */
transcriptsDir?: string
/**
 * statusLine hook ingest; the route exists only when the credential is set.
 */
statusLine?: {
/**
 * Environment variable name holding the ingest bearer token, never its value.
 */
credentialEnv: string
}
/**
 * ISO-8601 OAuth poll interval while a session is active; clamped to at least PT2M.
 */
activeInterval?: string
/**
 * ISO-8601 OAuth poll interval while idle; clamped to at least PT2M.
 */
idleInterval?: string
}
/**
 * Codex (ChatGPT subscription) usage; presence enables the Codex panel.
 */
codex?: {
/**
 * Read-write CODEX_HOME holding auth.json (the app-server refreshes it); mount the host's ~/.codex at the same path so its absolute symlinks resolve.
 */
codexHome: string
/**
 * Codex executable path as deck sees it; defaults to codex on PATH. The deck image ships no codex: mount the host's Linux binary and point this at it.
 */
command?: string
/**
 * Optional rollout sessions directory; defaults to <codexHome>/sessions.
 */
rolloutDir?: string
}
/**
 * Percent-used bands for warn and danger tones.
 */
thresholds?: {
/**
 * Percent used at which a bar turns warn; default 75.
 */
warn?: number
/**
 * Percent used at which a bar turns danger; default 90.
 */
danger?: number
}
/**
 * ISO-8601 duration without a viewer after which upstream polling pauses; default PT5M.
 */
idlePause?: string
}
