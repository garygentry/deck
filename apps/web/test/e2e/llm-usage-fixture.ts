/**
 * An invented, fully populated `GET /api/llm-usage` response for E2E specs: every bar
 * severity, every source state family, transcript totals and Codex history. Times are
 * relative to `now` so relative wording is stable under a fixed browser clock.
 */

export type JsonObject = Record<string, unknown>;
const MINUTE = 60_000;

export function populatedLlmUsage(NOW: number): JsonObject {
  const bar = (key: string, label: string, percent: number, severity: string, src: string, extra: JsonObject = {}) => ({
    key,
    label,
    group: key.startsWith("session") || key.endsWith(":primary") ? "session" : "weekly",
    percent,
    resetsAt: NOW + 134 * MINUTE,
    reached: false,
    severity,
    src,
    observedAt: NOW - 3 * MINUTE,
    ...extra,
  });

  return {
    enabled: true,
    now: NOW,
    poll: { mode: "active", nextPollAt: NOW + 2 * MINUTE, consecutiveErrors: 0 },
    thresholds: { warn: 75, danger: 90 },
    claude: {
      plan: "max",
      bars: [
        bar("session", "Current session", 24, "normal", "statusLine"),
        bar("weekly_all", "All models", 78, "warn", "oauth", { resetsAt: NOW + 76 * 60 * MINUTE }),
        bar("model:Opus", "Opus", 100, "danger", "oauth", { reached: true }),
      ],
      sources: [
        { id: "claude.statusLine", state: "available", observedAt: NOW - MINUTE, detail: null },
        { id: "claude.oauth", state: "stale", observedAt: NOW - 12 * MINUTE, detail: "HTTP 429" },
        { id: "claude.transcripts", state: "available", observedAt: NOW - MINUTE, detail: null },
      ],
      transcripts: {
        window5h: { input: 12_000, output: 410_000, cacheRead: 2_100_000, cacheCreate: 40_000, messages: 212 },
        window7d: { input: 98_000, output: 2_672_245, cacheRead: 31_000_000, cacheCreate: 510_000, messages: 1880 },
        byModel: {},
        files: 214,
      },
    },
    codex: {
      plan: "plus",
      resetCredits: 1,
      bars: [
        bar("codex:primary", "Codex · 5h limit", 12, "normal", "app-server"),
        bar("codex:secondary", "Codex · weekly limit", 41, "normal", "rollout"),
      ],
      sources: [
        { id: "codex.appServer", state: "available", observedAt: NOW - MINUTE, detail: null },
        { id: "codex.rollout", state: "available", observedAt: NOW - 30_000, detail: null },
        { id: "codex.history", state: "available", observedAt: NOW - 20 * MINUTE, detail: null },
      ],
      history: {
        lifetimeTokens: 48_200_000,
        peakDailyTokens: 3_900_000,
        currentStreakDays: 4,
        longestStreakDays: 11,
        longestRunningTurnSec: 1320,
        days: [
          { date: "2026-01-12", tokens: 820_000 },
          { date: "2026-01-13", tokens: 1_450_000 },
          { date: "2026-01-14", tokens: 390_000 },
          { date: "2026-01-15", tokens: 120_000 },
        ],
      },
    },
  };
}
