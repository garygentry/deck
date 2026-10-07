import { clampPercent, toEpochMs } from "../severity.js";
import type { UsageBarDraft, UsageGroup } from "../types.js";

/**
 * Claude adapters. Keys are canonical across sources (`session`, `weekly_all`,
 * `model:<name>`) so the statusLine and OAuth bars for the same window merge by key.
 *
 * Parsers are deliberately tolerant: the statusLine schema says `utilization` +
 * ISO `resets_at`, but public write-ups say `used_percentage` + epoch seconds, and
 * reading the wrong one yields an empty panel with no error. Accept both, and treat
 * every window as optional.
 */

type JsonRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function percentOf(window: JsonRecord): number | null {
  const value = window.utilization ?? window.used_percentage;
  return typeof value === "number" && Number.isFinite(value) ? clampPercent(value) : null;
}

const STATUSLINE_WINDOWS: readonly (readonly [field: string, key: string, label: string, group: UsageGroup])[] = [
  ["five_hour", "session", "Current session", "session"],
  ["seven_day", "weekly_all", "All models", "weekly"],
  ["seven_day_opus", "model:Opus", "Opus", "weekly"],
  ["seven_day_sonnet", "model:Sonnet", "Sonnet", "weekly"],
  ["seven_day_oauth_apps", "oauth_apps", "OAuth apps", "weekly"],
  ["spend_limit", "spend", "Spend limit", "spend"],
];

/** What a statusLine payload says about plan limits. */
export type StatuslineVerdict =
  | { kind: "not-applicable" }
  | { kind: "no-data-yet" }
  | { kind: "bars"; bars: UsageBarDraft[] };

/**
 * Parse a statusLine payload. `rate_limits_available: false` means plan limits do not
 * apply (API key, Bedrock, Vertex, token without the profile scope): not an error.
 * `rate_limits` is also absent until the first API response of a session.
 */
export function readStatusline(payload: unknown): StatuslineVerdict {
  if (!isRecord(payload)) return { kind: "no-data-yet" };
  if (payload.rate_limits_available === false) return { kind: "not-applicable" };
  const limits = payload.rate_limits;
  if (!isRecord(limits)) return { kind: "no-data-yet" };

  const bars: UsageBarDraft[] = [];
  for (const [field, key, label, group] of STATUSLINE_WINDOWS) {
    const window = limits[field];
    if (!isRecord(window)) continue;
    const percent = percentOf(window);
    if (percent === null) continue;
    bars.push({ key, label, group, percent, resetsAt: toEpochMs(window.resets_at), reached: false });
  }
  for (const scoped of Array.isArray(limits.model_scoped) ? limits.model_scoped : []) {
    if (!isRecord(scoped)) continue;
    const percent = percentOf(scoped);
    if (percent === null) continue;
    const name = typeof scoped.display_name === "string" && scoped.display_name ? scoped.display_name : "Model";
    bars.push({
      key: `model:${name}`, label: name, group: "weekly", percent,
      resetsAt: toEpochMs(scoped.resets_at), reached: false,
    });
  }
  return bars.length ? { kind: "bars", bars } : { kind: "no-data-yet" };
}

/** The subscription type a statusLine payload reports, if any. */
export function statuslinePlan(payload: unknown): string | null {
  return isRecord(payload) && typeof payload.subscription_type === "string" ? payload.subscription_type : null;
}

function oauthKeyAndLabel(limit: JsonRecord): { key: string; label: string } {
  const kind = typeof limit.kind === "string" ? limit.kind : "limit";
  const scope = isRecord(limit.scope) && isRecord(limit.scope.model) ? limit.scope.model : null;
  const model = scope && typeof scope.display_name === "string" ? scope.display_name : null;
  if (kind === "session") return { key: "session", label: "Current session" };
  if (kind === "weekly_all") return { key: "weekly_all", label: "All models" };
  if (kind === "weekly_scoped") return model ? { key: `model:${model}`, label: model } : { key: kind, label: "Scoped weekly" };
  return { key: model ? `${kind}:${model}` : kind, label: model ?? kind.replace(/_/g, " ") };
}

function oauthGroup(limit: JsonRecord): UsageGroup {
  if (limit.group === "session" || limit.group === "weekly" || limit.group === "spend") return limit.group;
  const kind = typeof limit.kind === "string" ? limit.kind : "";
  if (kind === "session") return "session";
  return kind.startsWith("weekly") ? "weekly" : "spend";
}

/**
 * Parse the `/api/oauth/usage` body. `limits[]` maps 1:1 to the desktop panel rows;
 * the flat `five_hour`/`seven_day` mirror is the fallback when `limits` is absent.
 * Null-valued codename buckets are ignored.
 */
export function barsFromOauth(body: unknown): UsageBarDraft[] {
  if (!isRecord(body)) return [];
  const bars: UsageBarDraft[] = [];
  for (const limit of Array.isArray(body.limits) ? body.limits : []) {
    if (!isRecord(limit) || typeof limit.percent !== "number" || !Number.isFinite(limit.percent)) continue;
    bars.push({
      ...oauthKeyAndLabel(limit),
      group: oauthGroup(limit),
      percent: clampPercent(limit.percent),
      resetsAt: toEpochMs(limit.resets_at),
      reached: limit.severity === "reached",
    });
  }
  if (bars.length) return bars;
  for (const [field, key, label, group] of STATUSLINE_WINDOWS.slice(0, 2)) {
    const window = body[field];
    if (!isRecord(window)) continue;
    const percent = percentOf(window);
    if (percent === null) continue;
    bars.push({ key, label, group, percent, resetsAt: toEpochMs(window.resets_at), reached: false });
  }
  return bars;
}
