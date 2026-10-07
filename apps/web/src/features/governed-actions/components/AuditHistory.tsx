/**
 * Read-only audit history: a newest-first list of past invocations with an inline
 * per-entry detail (the full entry including the unredacted params, and the
 * captured output). It performs no writes.
 *
 * Loads the list on mount with a live-flag-guarded effect.
 * Outcomes render through the shared `OUTCOME_UI` icon+text mapping. Rows are
 * whole-row buttons (Enter/click opens the detail under the row); Esc inside the
 * detail closes it, routed through the pure `keyboard.ts` module, and returns
 * focus to the row.
 */

import type { AuditDetail, AuditListItem } from "@deck/server/actions";
import type { JSX, KeyboardEvent, ReactNode } from "react";
import { useEffect, useState } from "react";
import {
  Button,
  Callout,
  CodeBlock,
  EmptyState,
  ErrorState,
  KeyValue,
  KeyValueList,
  List,
  ListItem,
  LoadingState,
  Section,
  StatusBadge,
} from "@/ui";
import { fetchAudit, fetchAuditDetail } from "../client.js";
import { resolveActionIntent, shouldPreventActionDefault } from "../keyboard.js";
import { OUTCOME_UI, showsExitCode, targetLabel } from "../status.js";

/** Props for {@link AuditHistory}. */
export interface AuditHistoryProps {
  /** Injectable list loader (defaults to client.fetchAudit) — enables tests without HTTP. */
  readonly loadList?: () => Promise<AuditListItem[]>;
  /** Injectable detail loader (defaults to client.fetchAuditDetail). */
  readonly loadDetail?: (runId: string) => Promise<AuditDetail | undefined>;
  /**
   * Whether the actions capability is enabled. When `false`, the audit list is
   * never requested (it would 403) and a disabled notice renders instead.
   */
  readonly enabled?: boolean;
}

type ListState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly items: readonly AuditListItem[] }
  | { readonly status: "error" }
  | { readonly status: "disabled" };

type DetailState =
  | { readonly status: "closed" }
  | { readonly status: "loading"; readonly runId: string }
  | { readonly status: "ready"; readonly runId: string; readonly detail: AuditDetail }
  | { readonly status: "not-found"; readonly runId: string }
  | { readonly status: "error"; readonly runId: string };

/** The DOM id of one audit row (the focus target when its detail closes). */
function rowId(runId: string): string {
  return `actions-audit-${runId.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

/** The outcome as a status badge: icon + text, never colour alone. */
function OutcomeBadge({ outcome }: { readonly outcome: AuditListItem["outcome"] }): JSX.Element {
  // Static text in a list: no live-region role (the map role is for the run banner).
  return StatusBadge.fromMap(OUTCOME_UI, outcome, { role: undefined });
}

/** The per-entry detail view: the full entry (incl. unredacted params) + captured output. */
function AuditDetailView({
  detail,
  onClose,
}: {
  readonly detail: AuditDetail;
  readonly onClose: () => void;
}): JSX.Element {
  const { entry, output } = detail;
  const paramEntries = Object.entries(entry.params);
  const target = targetLabel(entry.target);
  const paramsHeadingId = `${rowId(entry.runId)}-params`;

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    // Only Escape is handled here: Enter must stay with the focused control (Close).
    const intent = resolveActionIntent(event);
    if (intent !== "cancel") return;
    if (shouldPreventActionDefault(intent)) event.preventDefault();
    onClose();
  };

  return (
    <div
      data-slot="actions-audit-detail"
      className="flex flex-col gap-3 rounded-md border bg-background p-3 text-foreground"
      onKeyDown={onKeyDown}
    >
      <h3 className="font-mono text-sm font-semibold">{entry.actionId}</h3>
      <KeyValueList>
        <KeyValue label="Run id" value={<span className="font-mono">{entry.runId}</span>} />
        <KeyValue label="Timestamp" value={<time dateTime={entry.timestamp}>{entry.timestamp}</time>} />
        <KeyValue label="Runner" value={<span className="font-mono">{entry.runner}</span>} />
        {target !== null ? <KeyValue label="Target" value={target} /> : null}
        <KeyValue label="Source" value={<span className="font-mono">{entry.source}</span>} />
        <KeyValue label="Outcome" value={<OutcomeBadge outcome={entry.outcome} />} />
      </KeyValueList>
      {paramEntries.length > 0 ? (
        <div className="flex flex-col gap-2">
          <h4 id={paramsHeadingId} className="text-xs font-medium text-muted-foreground uppercase">
            Parameters
          </h4>
          <KeyValueList aria-labelledby={paramsHeadingId}>
          {paramEntries.map(([name, value]) => (
            <KeyValue
              key={name}
              label={<span className="font-mono">{name}</span>}
              value={<span className="font-mono">{String(value)}</span>}
              />
            ))}
          </KeyValueList>
        </div>
      ) : null}
      <CodeBlock code={output} caption="Captured output" wrap maxHeight="20rem" />
      <div>
        <Button type="button" variant="outline" size="sm" onClick={onClose}>
          Close
        </Button>
      </div>
    </div>
  );
}

/** The detail slot under the open row: loading, not found, failed, or the entry. */
function DetailSlot({
  state,
  onClose,
}: {
  readonly state: Exclude<DetailState, { status: "closed" }>;
  readonly onClose: () => void;
}): JSX.Element {
  switch (state.status) {
    case "loading":
      return <LoadingState label="Loading run detail…" rows={2} />;
    case "not-found":
      return (
        <Callout compact tone="neutral" role="status">
          That audit entry could not be found.
        </Callout>
      );
    case "error":
      return <ErrorState compact title="Failed to load audit entry." />;
    case "ready":
      return <AuditDetailView detail={state.detail} onClose={onClose} />;
  }
}

/**
 * Render the read-only audit history: newest-first list + selectable per-entry detail.
 */
export function AuditHistory({
  loadList = fetchAudit,
  loadDetail = fetchAuditDetail,
  enabled = true,
}: AuditHistoryProps): JSX.Element {
  const [list, setList] = useState<ListState>({ status: "loading" });
  const [detail, setDetail] = useState<DetailState>({ status: "closed" });

  useEffect(() => {
    // The capability is off: reading the audit log would 403, so skip the request
    // and render the disabled notice instead.
    if (!enabled) {
      setList({ status: "disabled" });
      return;
    }
    let live = true;
    loadList()
      .then((items) => {
        if (live) setList({ status: "ready", items });
      })
      .catch(() => {
        if (live) setList({ status: "error" });
      });
    return () => {
      live = false;
    };
  }, [loadList, enabled]);

  const openDetail = (runId: string): void => {
    setDetail({ status: "loading", runId });
    // Apply a response only while its run is still the one requested, so a slow
    // reply for an earlier row never replaces (or reopens) a later choice.
    const settle = (next: DetailState): void => {
      setDetail((prior) => (prior.status === "loading" && prior.runId === runId ? next : prior));
    };
    loadDetail(runId)
      .then((found) => {
        settle(
          found === undefined
            ? { status: "not-found", runId }
            : { status: "ready", runId, detail: found },
        );
      })
      .catch(() => {
        settle({ status: "error", runId });
      });
  };

  const closeDetail = (): void => {
    const openRunId = detail.status === "closed" ? null : detail.runId;
    setDetail({ status: "closed" });
    // Return focus to the row the detail belonged to, so it isn't lost to <body>.
    if (openRunId !== null) {
      document.getElementById(rowId(openRunId))?.querySelector<HTMLElement>("button")?.focus();
    }
  };

  let body: ReactNode = null;
  if (list.status === "loading") {
    body = <LoadingState label="Loading history…" rows={2} />;
  } else if (list.status === "disabled") {
    body = (
      <Callout compact tone="neutral" icon="ban" role="status">
        Audit history is unavailable while the actions capability is disabled.
      </Callout>
    );
  } else if (list.status === "error") {
    body = <ErrorState compact title="Failed to load audit history." />;
  } else if (list.items.length === 0) {
    body = <EmptyState compact title="No invocations recorded yet." />;
  } else {
    body = (
      <List variant="divided">
        {list.items.map((item) => {
          const target = targetLabel(item.target);
          const open = detail.status !== "closed" && detail.runId === item.runId;
          return (
            <ListItem
              key={item.runId}
              id={rowId(item.runId)}
              leading={<OutcomeBadge outcome={item.outcome} />}
              title={<span className="font-mono">{item.actionId}</span>}
              description={
                <span className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs">
                  <time dateTime={item.timestamp} className="font-mono whitespace-nowrap">
                    {item.timestamp}
                  </time>
                  <span className="whitespace-nowrap">Runner: {item.runner}</span>
                  {target !== null ? <span className="break-all">Target: {target}</span> : null}
                  {showsExitCode(item.outcome) && item.exitStatus !== null ? (
                    <span className="font-mono whitespace-nowrap">Exit code {item.exitStatus}</span>
                  ) : null}
                  <span className="font-mono whitespace-nowrap">{item.durationMs} ms</span>
                </span>
              }
              onSelect={() => openDetail(item.runId)}
              selected={open}
            >
              {detail.status !== "closed" && detail.runId === item.runId ? (
                // Above the row's stretched button, so the detail stays selectable and clickable.
                <div className="relative z-10 mt-2 cursor-auto">
                  <DetailSlot state={detail} onClose={closeDetail} />
                </div>
              ) : null}
            </ListItem>
          );
        })}
      </List>
    );
  }

  return (
    <Section title="Audit history" headingId="actions-audit-heading">
      {body}
    </Section>
  );
}
