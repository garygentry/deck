import { describe, expect, it } from "vitest";

import { barsFromOauth, readStatusline, statuslinePlan } from "../src/llm-usage/claude/bars.js";
import { mergeClaudeBars, STATUSLINE_FRESH_MS } from "../src/llm-usage/claude/merge.js";
import { accumulateTranscriptLine, emptyTotals } from "../src/llm-usage/claude/transcripts.js";
import {
  barsFromSnapshotMap,
  codexPlan,
  historyFromUsage,
  parseRolloutTail,
  windowLabel,
} from "../src/llm-usage/codex/bars.js";
import { finalizeBars, severityFor, toEpochMs } from "../src/llm-usage/severity.js";
import type { UsageBarDraft } from "../src/llm-usage/types.js";

const THRESHOLDS = { warn: 75, danger: 90 };
const RESET_ISO = "2026-09-03T13:00:00Z";
const RESET_MS = Date.parse(RESET_ISO);

describe("severity and timestamps", () => {
  it("bands by threshold; reached and 100% are always danger", () => {
    expect(severityFor(74.9, false, THRESHOLDS)).toBe("normal");
    expect(severityFor(75, false, THRESHOLDS)).toBe("warn");
    expect(severityFor(90, false, THRESHOLDS)).toBe("danger");
    expect(severityFor(10, true, THRESHOLDS)).toBe("danger");
    expect(severityFor(100, false, { warn: 100, danger: 100 })).toBe("danger");
  });

  it("normalizes ISO strings and epoch seconds to epoch ms", () => {
    expect(toEpochMs(RESET_ISO)).toBe(RESET_MS);
    expect(toEpochMs(RESET_MS / 1000)).toBe(RESET_MS);
    expect(toEpochMs(RESET_MS)).toBe(RESET_MS);
    expect(toEpochMs("not a date")).toBeNull();
    expect(toEpochMs(null)).toBeNull();
    expect(toEpochMs(0)).toBeNull();
  });
});

describe("Claude statusLine", () => {
  const payload = {
    subscription_type: "max",
    rate_limits_available: true,
    rate_limits: {
      five_hour: { utilization: 63, resets_at: "2026-09-02T23:30:00Z" },
      seven_day: { utilization: 58, resets_at: RESET_ISO },
      seven_day_opus: null,
      seven_day_sonnet: null,
      model_scoped: [{ display_name: "Fable", utilization: 36, resets_at: RESET_ISO }],
    },
  };

  it("reads utilization, ISO resets, and the per-model row", () => {
    const verdict = readStatusline(payload);
    expect(verdict.kind).toBe("bars");
    if (verdict.kind !== "bars") return;
    expect(verdict.bars.map((bar) => [bar.key, bar.label, bar.group, bar.percent])).toEqual([
      ["session", "Current session", "session", 63],
      ["weekly_all", "All models", "weekly", 58],
      ["model:Fable", "Fable", "weekly", 36],
    ]);
    expect(verdict.bars[1]!.resetsAt).toBe(RESET_MS);
    expect(statuslinePlan(payload)).toBe("max");
  });

  it("tolerates the used_percentage spelling and epoch-second resets", () => {
    const verdict = readStatusline({ rate_limits: { five_hour: { used_percentage: 12, resets_at: RESET_MS / 1000 } } });
    expect(verdict).toEqual({
      kind: "bars",
      bars: [{ key: "session", label: "Current session", group: "session", percent: 12, resetsAt: RESET_MS, reached: false }],
    });
  });

  it("distinguishes not-applicable from no-data-yet", () => {
    expect(readStatusline({ rate_limits_available: false, rate_limits: null })).toEqual({ kind: "not-applicable" });
    expect(readStatusline({ rate_limits_available: true })).toEqual({ kind: "no-data-yet" });
    expect(readStatusline({ rate_limits: { five_hour: { utilization: null } } })).toEqual({ kind: "no-data-yet" });
    expect(readStatusline("garbage")).toEqual({ kind: "no-data-yet" });
  });
});

describe("Claude OAuth", () => {
  it("maps limits[] to canonical keys and ignores null codename buckets", () => {
    const bars = barsFromOauth({
      limits: [
        { kind: "session", percent: 59, resets_at: RESET_ISO, is_active: true },
        { kind: "weekly_all", percent: 57, resets_at: RESET_ISO },
        { kind: "weekly_scoped", percent: 36, resets_at: RESET_ISO, scope: { model: { display_name: "Fable" } } },
        { kind: "weekly_all", percent: null },
      ],
      tangelo: null,
      nimbus_quill: null,
    });
    expect(bars.map((bar) => [bar.key, bar.group, bar.percent])).toEqual([
      ["session", "session", 59],
      ["weekly_all", "weekly", 57],
      ["model:Fable", "weekly", 36],
    ]);
  });

  it("falls back to the flat windows when limits[] is absent", () => {
    expect(barsFromOauth({ five_hour: { utilization: 40, resets_at: RESET_ISO } }).map((bar) => bar.key)).toEqual(["session"]);
    expect(barsFromOauth(null)).toEqual([]);
  });

  it("flags a reached limit", () => {
    expect(barsFromOauth({ limits: [{ kind: "session", percent: 100, severity: "reached" }] })[0]!.reached).toBe(true);
  });
});

describe("Claude merge", () => {
  const now = 1_000_000_000_000;
  const draft = (key: string, percent: number, group: UsageBarDraft["group"] = "weekly"): UsageBarDraft =>
    ({ key, label: key, group, percent, resetsAt: null, reached: false });
  const statusline = finalizeBars([draft("session", 63, "session"), draft("weekly_all", 58)], "statusLine", now, THRESHOLDS);
  const oauth = finalizeBars(
    [draft("session", 50, "session"), draft("weekly_all", 50), draft("model:Fable", 36)],
    "oauth", now, THRESHOLDS,
  );

  it("prefers a fresh statusLine per key and keeps OAuth-only rows", () => {
    const merged = mergeClaudeBars(statusline, now - 1000, oauth, now);
    expect(merged.map((bar) => [bar.key, bar.src, bar.percent])).toEqual([
      ["session", "statusLine", 63],
      ["weekly_all", "statusLine", 58],
      ["model:Fable", "oauth", 36],
    ]);
  });

  it("defers to OAuth once the statusLine is stale, but keeps stale-only rows", () => {
    const merged = mergeClaudeBars(
      [...statusline, ...finalizeBars([draft("spend", 5, "spend")], "statusLine", now, THRESHOLDS)],
      now - STATUSLINE_FRESH_MS, oauth, now,
    );
    expect(merged.map((bar) => [bar.key, bar.src])).toEqual([
      ["session", "oauth"], ["weekly_all", "oauth"], ["model:Fable", "oauth"], ["spend", "statusLine"],
    ]);
  });

  it("lets a stale push beat an older OAuth value frozen by 429s", () => {
    const pushAt = now - 6 * 60_000;
    const push = finalizeBars([draft("session", 80, "session")], "statusLine", pushAt, THRESHOLDS);
    const frozen = finalizeBars([draft("session", 20, "session")], "oauth", now - 3 * 3_600_000, THRESHOLDS);
    expect(mergeClaudeBars(push, pushAt, frozen, now).map((bar) => [bar.src, bar.percent])).toEqual([["statusLine", 80]]);
  });

  it("survives an OAuth outage with statusLine bars alone", () => {
    expect(mergeClaudeBars(statusline, now, [], now)).toHaveLength(2);
  });
});

describe("Claude transcripts", () => {
  it("sums token usage into 5h/7d windows and per model, skipping old and malformed lines", () => {
    const now = Date.parse("2026-09-24T12:00:00Z");
    const totals = emptyTotals();
    const line = (timestamp: string, input: number) => JSON.stringify({
      timestamp, message: { model: "claude-fable-5-1", usage: { input_tokens: input, output_tokens: 1, cache_read_input_tokens: 2 } },
    });
    for (const text of [
      line("2026-09-24T11:00:00Z", 10),
      line("2026-09-22T11:00:00Z", 100),
      line("2026-09-01T11:00:00Z", 1000),
      "{\"usage\": broken",
      "{\"type\":\"user\"}",
    ]) accumulateTranscriptLine(totals, text, now);
    expect(totals.window5h).toMatchObject({ input: 10, messages: 1 });
    expect(totals.window7d).toMatchObject({ input: 110, output: 2, cacheRead: 4, messages: 2 });
    expect(totals.byModel["claude-fable-5-1"]!.messages).toBe(2);
  });
});

describe("Codex", () => {
  const response = {
    rateLimits: { limitId: "codex", primary: { usedPercent: 48, windowDurationMins: 10080, resetsAt: 1788814634 }, secondary: null, planType: "prolite" },
    rateLimitsByLimitId: {
      codex_bengalfox: {
        limitName: "GPT-5.3-Codex-Spark",
        primary: { usedPercent: 0, windowDurationMins: 300 },
        secondary: { usedPercent: 0, windowDurationMins: 10080 },
      },
      codex: { primary: { usedPercent: 48, windowDurationMins: 10080, resetsAt: 1788814634 }, secondary: null, planType: "prolite" },
    },
  };

  it("labels windows from their duration", () => {
    expect([30, 300, 1440, 10080, 43200, null].map(windowLabel)).toEqual(
      ["30m limit", "5h limit", "1d limit", "weekly limit", "30d limit", "limit"],
    );
  });

  it("flattens buckets with the account-wide bucket first and epoch-second resets as ms", () => {
    const bars = barsFromSnapshotMap(response.rateLimitsByLimitId, response.rateLimits);
    expect(bars.map((bar) => [bar.key, bar.label, bar.group])).toEqual([
      ["codex:primary", "Codex · weekly limit", "weekly"],
      ["codex_bengalfox:primary", "GPT-5.3-Codex-Spark · 5h limit", "session"],
      ["codex_bengalfox:secondary", "GPT-5.3-Codex-Spark · weekly limit", "weekly"],
    ]);
    expect(bars[0]!.resetsAt).toBe(1788814634 * 1000);
    expect(codexPlan(response.rateLimitsByLimitId, response.rateLimits)).toBe("prolite");
  });

  it("falls back to the single bucket and flags reached limits", () => {
    const bars = barsFromSnapshotMap({}, { ...response.rateLimits, rateLimitReachedType: "primary" });
    expect(bars).toHaveLength(1);
    expect(bars[0]!.reached).toBe(true);
    expect(barsFromSnapshotMap(null, null)).toEqual([]);
  });

  it("parses the newest snake_case snapshot from a rollout tail, skipping a partial first line", () => {
    const event = (percent: number) => JSON.stringify({
      timestamp: "2026-09-24T10:00:00Z",
      type: "event_msg",
      payload: { type: "token_count", rate_limits: { primary: { used_percent: percent, window_minutes: 10080, resets_at: 1788814634 }, plan_type: "plus" } },
    });
    const reading = parseRolloutTail(`ate_limits":{"partial\n${event(40)}\n{"type":"other"}\n${event(48)}\n`);
    expect(reading?.at).toBe(Date.parse("2026-09-24T10:00:00Z"));
    expect(barsFromSnapshotMap(null, reading?.snapshot)[0]).toMatchObject({ key: "codex:primary", percent: 48 });
    expect(parseRolloutTail("{\"type\":\"other\"}")).toBeNull();
  });

  it("normalizes account/usage/read history", () => {
    const buckets = Array.from({ length: 40 }, (_, day) => ({ startDate: `2026-08-${String(day + 1).padStart(2, "0")}`, tokens: day }));
    const history = historyFromUsage({ summary: { lifetimeTokens: 1e9, currentStreakDays: null }, dailyUsageBuckets: buckets });
    expect(history).toMatchObject({ lifetimeTokens: 1e9, currentStreakDays: null, peakDailyTokens: null });
    expect(history!.days).toHaveLength(30);
    expect(history!.days.at(-1)).toEqual({ date: "2026-08-40", tokens: 39 });
    expect(historyFromUsage(undefined)).toBeNull();
    const newestFirst = historyFromUsage({ dailyUsageBuckets: [...buckets].reverse() });
    expect(newestFirst!.days.at(-1)).toEqual({ date: "2026-08-40", tokens: 39 });
  });
});
