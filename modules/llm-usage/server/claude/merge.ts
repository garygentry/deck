import type { UsageBar } from "../types.js";

/** statusLine bars older than this defer to OAuth bars for the same key. */
export const STATUSLINE_FRESH_MS = 5 * 60_000;

/**
 * Merge the two Claude sources by canonical key. A fresh statusLine bar wins; otherwise
 * the newer observation of that key wins, so an OAuth value frozen by hours of 429s never
 * beats a push from a few minutes ago. Either source failing costs at most the bars only
 * it had, never the whole panel.
 */
export function mergeClaudeBars(
  statusline: readonly UsageBar[],
  statuslineAt: number | null,
  oauth: readonly UsageBar[],
  now: number,
): UsageBar[] {
  const fresh = statuslineAt !== null && now - statuslineAt < STATUSLINE_FRESH_MS;
  const merged = new Map<string, UsageBar>();
  if (fresh) for (const bar of statusline) merged.set(bar.key, bar);
  for (const bar of oauth) if (!merged.has(bar.key)) merged.set(bar.key, bar);
  if (!fresh) {
    for (const bar of statusline) {
      const current = merged.get(bar.key);
      if (!current || bar.observedAt > current.observedAt) merged.set(bar.key, bar);
    }
  }
  return sortClaudeBars([...merged.values()]);
}

function rank(bar: UsageBar): number {
  if (bar.key === "session") return 0;
  if (bar.key === "weekly_all") return 1;
  if (bar.group === "weekly") return 2;
  return 3;
}

/** The desktop panel's order: session, all models, per-model weekly, then spend. */
export function sortClaudeBars(bars: UsageBar[]): UsageBar[] {
  return bars.sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label));
}
