/**
 * Wire types for the LLM usage feature (`GET /api/llm-usage`), consumed by apps/web via
 * `@deck/server/llm-usage` (types only). Every source normalizes into one flat
 * {@link UsageBar}, so the UI never needs to know which CLI or method produced a number.
 */

/** Which limit window a bar measures. */
export type UsageGroup = "session" | "weekly" | "spend";

/** Threshold band derived from percent used and the configured thresholds. */
export type UsageSeverity = "normal" | "warn" | "danger";

/** The method that produced a bar; surfaced per bar so a stale number is attributable. */
export type UsageBarSource = "statusLine" | "oauth" | "app-server" | "rollout";

export interface UsageBar {
  /** Stable identity across sources and polls, e.g. `session`, `model:Fable`, `codex:primary`. */
  key: string;
  /** Display label, e.g. "Current session", "All models", "Codex · weekly limit". */
  label: string;
  group: UsageGroup;
  /** Percent of the window used, clamped to 0–100. */
  percent: number;
  /** Window reset time in epoch milliseconds; null when the source did not say. */
  resetsAt: number | null;
  /** The provider flagged this limit as reached. */
  reached: boolean;
  severity: UsageSeverity;
  src: UsageBarSource;
  /** Epoch ms when the producing source last delivered this value. */
  observedAt: number;
}

/** A bar as an adapter produces it, before attribution and banding. */
export type UsageBarDraft = Omit<UsageBar, "severity" | "src" | "observedAt">;

/**
 * Per-source state. `not-applicable` (plan limits don't apply to this auth) and
 * `not-configured` (deck was not given what it needs) are distinct from `error`.
 */
export type UsageSourceState =
  | "available"
  | "not-configured"
  | "not-applicable"
  | "no-data-yet"
  | "stale"
  | "error";

export type UsageSourceId =
  | "claude.statusLine"
  | "claude.oauth"
  | "claude.transcripts"
  | "codex.appServer"
  | "codex.rollout"
  | "codex.history";

export interface UsageSourceStatus {
  id: UsageSourceId;
  state: UsageSourceState;
  /** Epoch ms of the last successful delivery, if any. */
  observedAt: number | null;
  /** Short human-readable reason for any non-`available` state. */
  detail: string | null;
}

export interface TokenCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
  messages: number;
}

/** Claude transcript scan: consumption in tokens, never quota percent. */
export interface TranscriptTotals {
  window5h: TokenCounts;
  window7d: TokenCounts;
  byModel: Record<string, TokenCounts>;
  files: number;
}

export interface CodexHistoryDay {
  /** Bucket start date as reported (YYYY-MM-DD). */
  date: string;
  tokens: number;
}

/** Codex `account/usage/read` history: lifetime counters plus recent daily buckets. */
export interface CodexHistory {
  lifetimeTokens: number | null;
  peakDailyTokens: number | null;
  currentStreakDays: number | null;
  longestStreakDays: number | null;
  longestRunningTurnSec: number | null;
  days: CodexHistoryDay[];
}

export type UsagePollMode = "active" | "idle" | "backoff" | "paused";

export interface UsageThresholds {
  warn: number;
  danger: number;
}

export interface ClaudeUsage {
  /** Subscription type as reported (`pro`, `max`, …), when known. */
  plan: string | null;
  /** Merged, render-ready bars. */
  bars: UsageBar[];
  sources: UsageSourceStatus[];
  transcripts: TranscriptTotals | null;
}

export interface CodexUsage {
  plan: string | null;
  /** Available "full reset" credits, when reported. */
  resetCredits: number | null;
  bars: UsageBar[];
  sources: UsageSourceStatus[];
  history: CodexHistory | null;
}

/** The `llmUsage` entry in `/api/health`: reported beside providers, never degrading overall status. */
export interface LlmUsageHealth {
  mode: UsagePollMode;
  lastPollAt: number | null;
  consecutiveErrors: number;
}

/** `GET /api/llm-usage` response. */
export interface LlmUsageResponse {
  /** False when the config has no `modules.llm-usage` section; every other field is then empty. */
  enabled: boolean;
  now: number;
  poll: {
    mode: UsagePollMode;
    /** Epoch ms of the next scheduled upstream poll; null while paused. */
    nextPollAt: number | null;
    consecutiveErrors: number;
  };
  thresholds: UsageThresholds;
  /** Null when the `claude` subsection is absent. */
  claude: ClaudeUsage | null;
  /** Null when the `codex` subsection is absent. */
  codex: CodexUsage | null;
}

declare module "../contract/api.js" {
  interface LegacyHealthFields {
    /** LLM usage collector state (the module's health `data`); present only when `modules.llm-usage` is configured. */
    llmUsage?: LlmUsageHealth;
  }
}
