import { clampPercent, toEpochMs } from "../severity.js";
import type { CodexHistory, UsageBarDraft } from "../types.js";

/**
 * Codex adapters over the app-server schema (`codex app-server generate-json-schema`,
 * `GetAccountRateLimitsResponse`). The rollout tail carries the same snapshot in
 * snake_case; {@link parseRolloutTail} normalizes it to this shape.
 */

type JsonRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export interface CodexWindow {
  usedPercent?: unknown;
  windowDurationMins?: unknown;
  resetsAt?: unknown;
}

export interface CodexSnapshot {
  limitId?: unknown;
  limitName?: unknown;
  planType?: unknown;
  primary?: CodexWindow | null;
  secondary?: CodexWindow | null;
  rateLimitReachedType?: unknown;
}

/**
 * `windowDurationMins` is the only thing separating a session window from a weekly
 * one, and which slot carries which window varies by plan, so label from duration.
 */
export function windowLabel(minutes: unknown): string {
  if (typeof minutes !== "number" || !Number.isFinite(minutes)) return "limit";
  if (minutes <= 60) return `${minutes}m limit`;
  if (minutes < 1440) return `${Math.round(minutes / 60)}h limit`;
  const days = Math.round(minutes / 1440);
  return days === 7 ? "weekly limit" : `${days}d limit`;
}

/**
 * Flatten `rateLimitsByLimitId` (falling back to the single-bucket `rateLimits`) into
 * one bar per populated window. Account-wide `codex` first, session before weekly,
 * so a 0% per-model row never buries the number that matters.
 */
export function barsFromSnapshotMap(byId: unknown, fallback: unknown): UsageBarDraft[] {
  let entries: [string, unknown][] = isRecord(byId) ? Object.entries(byId) : [];
  if (!entries.length && isRecord(fallback)) {
    entries = [[typeof fallback.limitId === "string" ? fallback.limitId : "codex", fallback]];
  }
  const bars: UsageBarDraft[] = [];
  for (const [id, snapshot] of entries) {
    if (!isRecord(snapshot)) continue;
    const who = typeof snapshot.limitName === "string" && snapshot.limitName
      ? snapshot.limitName
      : id === "codex" ? "Codex" : id;
    const reached = snapshot.rateLimitReachedType !== null && snapshot.rateLimitReachedType !== undefined;
    for (const slot of ["primary", "secondary"] as const) {
      const window = snapshot[slot];
      if (!isRecord(window) || typeof window.usedPercent !== "number" || !Number.isFinite(window.usedPercent)) continue;
      const minutes = typeof window.windowDurationMins === "number" ? window.windowDurationMins : null;
      bars.push({
        key: `${id}:${slot}`,
        label: `${who} · ${windowLabel(minutes)}`,
        group: (minutes ?? 0) >= 1440 ? "weekly" : "session",
        percent: clampPercent(window.usedPercent),
        resetsAt: toEpochMs(window.resetsAt),
        reached,
      });
    }
  }
  const rank = (bar: UsageBarDraft) => (bar.key.startsWith("codex:") ? 0 : 10) + (bar.group === "session" ? 0 : 1);
  return bars.sort((a, b) => rank(a) - rank(b));
}

/** Plan type from the account-wide bucket, when reported. */
export function codexPlan(byId: unknown, fallback: unknown): string | null {
  const account = isRecord(byId) && isRecord(byId.codex) ? byId.codex : fallback;
  return isRecord(account) && typeof account.planType === "string" ? account.planType : null;
}

function normalizeRolloutWindow(window: unknown): CodexWindow | null {
  if (!isRecord(window)) return null;
  return { usedPercent: window.used_percent, windowDurationMins: window.window_minutes, resetsAt: window.resets_at };
}

export interface RolloutReading {
  /** Event timestamp of the newest rate-limit snapshot, epoch ms. */
  at: number | null;
  snapshot: CodexSnapshot;
}

/**
 * Pull the newest `rate_limits` snapshot out of a rollout JSONL tail. The first line
 * of a tail window is usually partial, so unparseable lines are skipped.
 */
export function parseRolloutTail(text: string): RolloutReading | null {
  let found: RolloutReading | null = null;
  for (const line of text.split("\n")) {
    if (!line.includes("\"rate_limits\"")) continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(event) || !isRecord(event.payload) || !isRecord(event.payload.rate_limits)) continue;
    const limits = event.payload.rate_limits;
    found = {
      at: toEpochMs(event.timestamp),
      snapshot: {
        limitId: limits.limit_id,
        limitName: limits.limit_name,
        planType: limits.plan_type,
        primary: normalizeRolloutWindow(limits.primary),
        secondary: normalizeRolloutWindow(limits.secondary),
        rateLimitReachedType: limits.rate_limit_reached_type,
      },
    };
  }
  return found;
}

const numberOrNull = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/** Normalize `account/usage/read` into lifetime counters and the last `days` buckets. */
export function historyFromUsage(result: unknown, days = 30): CodexHistory | null {
  if (!isRecord(result)) return null;
  const summary = isRecord(result.summary) ? result.summary : {};
  const buckets = Array.isArray(result.dailyUsageBuckets) ? result.dailyUsageBuckets : [];
  return {
    lifetimeTokens: numberOrNull(summary.lifetimeTokens),
    peakDailyTokens: numberOrNull(summary.peakDailyTokens),
    currentStreakDays: numberOrNull(summary.currentStreakDays),
    longestStreakDays: numberOrNull(summary.longestStreakDays),
    longestRunningTurnSec: numberOrNull(summary.longestRunningTurnSec),
    days: buckets
      .filter((bucket): bucket is JsonRecord => isRecord(bucket) && typeof bucket.startDate === "string")
      .map((bucket) => ({ date: bucket.startDate as string, tokens: numberOrNull(bucket.tokens) ?? 0 }))
      .sort((a, b) => a.date.localeCompare(b.date)) // upstream order is not guaranteed
      .slice(-days),
  };
}
