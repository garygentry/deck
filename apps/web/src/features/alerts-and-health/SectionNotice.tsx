import type { FreshnessStamp } from "@deck/server";
import type { JSX, ReactNode } from "react";
import { Callout, EmptyState, FreshnessBadge } from "@/ui";

import { NOT_CONFIGURED_ICON, STATUS_PRESENTATION } from "./status.js";

/**
 * The three non-content section states the monitoring sections share. Each is a polite
 * `role="status"` region with icon + text, and the three stay visibly distinct:
 * - not configured: a quiet one-line empty state (never alarming);
 * - error: a neutral callout "Error — {source} unreachable." plus the freshness badge (the server's
 *   error message is never rendered);
 * - all clear: an ok callout "Healthy — {detail}" plus the freshness badge, when one is given.
 */
export function NotConfiguredNotice({ children }: { children: ReactNode }): JSX.Element {
  return <EmptyState compact icon={NOT_CONFIGURED_ICON} title={children} />;
}

export function SourceErrorNotice({
  source,
  freshness,
}: {
  source: string;
  freshness: FreshnessStamp | null;
}): JSX.Element {
  const error = STATUS_PRESENTATION.error;
  return (
    <Callout compact tone={error.tone} icon={error.icon} role="status">
      <NoticeLine freshness={freshness}>
        {error.label} — {source} unreachable.
      </NoticeLine>
    </Callout>
  );
}

export function AllClearNotice({
  children,
  freshness = null,
}: {
  children: ReactNode;
  freshness?: FreshnessStamp | null;
}): JSX.Element {
  const healthy = STATUS_PRESENTATION.healthy;
  return (
    <Callout compact tone={healthy.tone} icon={healthy.icon} role="status">
      <NoticeLine freshness={freshness}>
        {healthy.label} — {children}
      </NoticeLine>
    </Callout>
  );
}

function NoticeLine({
  freshness,
  children,
}: {
  freshness: FreshnessStamp | null;
  children: ReactNode;
}): JSX.Element {
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <span>{children}</span>
      {freshness !== null && <FreshnessBadge freshness={freshness} />}
    </span>
  );
}
