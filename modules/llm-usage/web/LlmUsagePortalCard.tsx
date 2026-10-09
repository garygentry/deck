import type { JSX } from "react";
import { FragmentBoundary, StatGrid, StatTile, useNow } from "@/ui";

import { SEVERITY_UI, formatResetIn, tightestBar } from "./status.js";
import { useLlmUsage, usageStore, type UsageStore } from "./store.js";

/** Portal summary: the tightest limit per provider, linking to `/usage`. Nothing when off or empty. */
export function LlmUsagePortalCard(): JSX.Element {
  return (
    <FragmentBoundary label="LLM usage summary" href="/usage">
      <LlmUsagePortalCardContent />
    </FragmentBoundary>
  );
}

export function LlmUsagePortalCardContent({ store = usageStore, now: fixedNow }: { store?: UsageStore; now?: number }): JSX.Element {
  const view = useLlmUsage(store);
  const ticking = useNow(60_000, fixedNow === undefined);
  if (view.status !== "ready" || !view.data.enabled) return <></>;
  const now = fixedNow ?? ticking + view.clockOffsetMs;
  const shown = [
    { provider: "Claude Code", bar: tightestBar(view.data.claude?.bars ?? []) },
    { provider: "Codex", bar: tightestBar(view.data.codex?.bars ?? []) },
  ].flatMap(({ provider, bar }) => (bar === null ? [] : [{ provider, bar }]));
  if (shown.length === 0) return <></>;
  return (
    <StatGrid role="group" aria-label="LLM usage">
      {shown.map(({ provider, bar }) => {
        const severity = SEVERITY_UI[bar.severity];
        return (
          <StatTile
            key={provider}
            label={`${provider} · ${bar.label}`}
            value={`${Math.round(bar.percent)}%`}
            tone={severity.tone}
            icon={severity.icon}
            subLabel={bar.resetsAt !== null ? `${severity.label} · resets ${formatResetIn(bar.resetsAt, now)}` : severity.label}
            href="/usage"
          />
        );
      })}
    </StatGrid>
  );
}
