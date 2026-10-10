import type {
  LlmUsageResponse,
  UsageBar,
  UsageBarSource,
  UsagePollMode,
  UsageSeverity,
  UsageSourceId,
  UsageSourceState,
} from "../server/types.js";
import { defineStatusMap, type StatusMap } from "@/ui";

/** A bar's threshold band. `danger` covers both "over the danger threshold" and "provider says reached". */
export const SEVERITY_UI: StatusMap<UsageSeverity> = defineStatusMap<UsageSeverity>({
  normal: { tone: "ok", icon: "circle-check", label: "Within limit" },
  warn: { tone: "warn", icon: "triangle-alert", label: "Nearing limit" },
  danger: { tone: "danger", icon: "octagon-alert", label: "At or near limit" },
});

/**
 * Per-source state. "Not applicable" (plan limits don't apply to this auth) and "not
 * configured" are quiet and never alarming; only `error` uses the danger tone.
 */
export const SOURCE_STATE_UI: StatusMap<UsageSourceState> = defineStatusMap<UsageSourceState>({
  available: { tone: "ok", icon: "circle-check", label: "Available" },
  "not-configured": { tone: "neutral", icon: "circle-minus", label: "Not configured" },
  "not-applicable": { tone: "neutral", icon: "circle-slash", label: "Not applicable" },
  "no-data-yet": { tone: "pending", icon: "hourglass", label: "No data yet" },
  stale: { tone: "warn", icon: "clock-alert", label: "Stale" },
  error: { tone: "danger", icon: "circle-x", label: "Error" },
});

export const POLL_MODE_UI: StatusMap<UsagePollMode> = defineStatusMap<UsagePollMode>({
  active: { tone: "ok", icon: "activity", label: "Active" },
  idle: { tone: "neutral", icon: "circle-dashed", label: "Idle" },
  backoff: { tone: "warn", icon: "clock-alert", label: "Backing off" },
  paused: { tone: "neutral", icon: "circle-stop", label: "Paused" },
});

export const SOURCE_NAMES: Readonly<Record<UsageSourceId, string>> = {
  "claude.statusLine": "statusLine push",
  "claude.oauth": "OAuth usage endpoint",
  "claude.transcripts": "Local transcripts",
  "codex.appServer": "app-server rate limits",
  "codex.rollout": "Rollout files",
  "codex.history": "Usage history",
};

export const BAR_SOURCE_NAMES: Readonly<Record<UsageBarSource, string>> = {
  statusLine: "statusLine",
  oauth: "OAuth",
  "app-server": "app-server",
  rollout: "rollout",
};

const SEVERITY_RANK: Readonly<Record<UsageSeverity, number>> = { normal: 0, warn: 1, danger: 2 };

/** The bar that most needs attention: worst severity, then highest percent. */
export function tightestBar(bars: readonly UsageBar[]): UsageBar | null {
  let worst: UsageBar | null = null;
  for (const bar of bars) {
    if (
      worst === null ||
      SEVERITY_RANK[bar.severity] > SEVERITY_RANK[worst.severity] ||
      (bar.severity === worst.severity && bar.percent > worst.percent)
    ) {
      worst = bar;
    }
  }
  return worst;
}

/** {@link tightestBar} across both providers. */
export function worstBar(data: LlmUsageResponse): UsageBar | null {
  return tightestBar([...(data.claude?.bars ?? []), ...(data.codex?.bars ?? [])]);
}

/** "in 2h 14m" / "in 3d 4h" / "in <1m"; "reset due" once the time has passed. */
export function formatResetIn(resetsAt: number, now: number): string {
  const ms = resetsAt - now;
  if (ms <= 0) return "reset due";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "in <1m";
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `in ${hours}h ${minutes % 60}m`;
  return `in ${Math.floor(hours / 24)}d ${hours % 24}h`;
}

const COMPACT = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });

/** Token counts are large; "2.7M" reads better than "2,672,245". */
export function formatTokens(value: number): string {
  return COMPACT.format(value);
}

export const toIso = (epochMs: number): string => new Date(epochMs).toISOString();
