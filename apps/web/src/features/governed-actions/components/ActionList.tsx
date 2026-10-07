/**
 * Grouped list of every declared action.
 *
 * Groups by `target.host` when present, else a single "Estate-wide" group. Each
 * row shows the action's `title`, `description`, and `target`. Selecting a row
 * raises `onSelect`; the selected row carries `aria-current`. Absent/empty
 * `actions` → a `role="status"` empty state, never `role="alert"`. This is the
 * ONLY surface for targeted actions in V1 — deck does not inject buttons into
 * host/service detail pages.
 */

import type { Action } from "@deck/server";
import type { JSX } from "react";
import { EmptyState, Icon, List, ListGroup, ListItem } from "@/ui";
import { targetLabel } from "../status.js";

/** Props for {@link ActionList}. */
export interface ActionListProps {
  /** All declared actions from DeckConfig.actions (may be empty). */
  readonly actions: readonly Action[];
  /** The currently selected action id, or null. Drives aria-current / active styling. */
  readonly selectedId: string | null;
  /** Raised when the operator picks an action (click or Enter on a focused row). */
  readonly onSelect: (action: Action) => void;
  /** When true (capability disabled), rows render read-only and raise no selection. */
  readonly readOnly?: boolean;
}

/** One display group: a target host, or the estate-wide bucket. */
export interface ActionGroup {
  /** Group key: the host name, or "" for the estate-wide group. */
  readonly host: string;
  /** Human label: the host name, or "Estate-wide". */
  readonly label: string;
  readonly actions: readonly Action[];
}

/** Human label for the target-less, estate-wide group. */
const ESTATE_WIDE_LABEL = "Estate-wide";

/**
 * Pure grouping helper (exported for standalone testing). Groups by `target.host`;
 * actions without a target fall into the estate-wide group. Groups are ordered
 * estate-wide first, then hosts alphabetically; actions within a group keep
 * declared order.
 */
export function groupActions(actions: readonly Action[]): readonly ActionGroup[] {
  const estateWide: Action[] = [];
  const byHost = new Map<string, Action[]>();

  for (const action of actions) {
    const host = action.target?.host;
    if (host === undefined) {
      estateWide.push(action);
      continue;
    }
    const bucket = byHost.get(host);
    if (bucket === undefined) byHost.set(host, [action]);
    else bucket.push(action);
  }

  const groups: ActionGroup[] = [];
  if (estateWide.length > 0) {
    groups.push({ host: "", label: ESTATE_WIDE_LABEL, actions: estateWide });
  }
  for (const host of [...byHost.keys()].sort((a, b) => a.localeCompare(b))) {
    groups.push({ host, label: host, actions: byHost.get(host)! });
  }
  return groups;
}

/**
 * Render the grouped action list, or the empty state when no actions are
 * declared. Selectable rows are whole-row buttons named by the action title
 * (the description and target describe it); read-only rows are static text.
 */
export function ActionList({
  actions,
  selectedId,
  onSelect,
  readOnly = false,
}: ActionListProps): JSX.Element {
  if (actions.length === 0) {
    return <EmptyState compact title="No actions are declared for this deck instance." />;
  }

  return (
    <div className="flex flex-col gap-5">
      {groupActions(actions).map((group) => (
        <ListGroup key={group.host} heading={group.label}>
          <List variant="card">
            {group.actions.map((action) => {
              const target = targetLabel(action.target);
              return (
                <ListItem
                  key={action.id}
                  leading={<Icon name="play-circle" className="text-muted-foreground" />}
                  title={action.title}
                  description={
                    action.description !== undefined || target !== null ? (
                      <span className="flex flex-col gap-0.5">
                        {action.description !== undefined ? <span>{action.description}</span> : null}
                        {target !== null ? (
                          <span className="font-mono text-xs">Target: {target}</span>
                        ) : null}
                      </span>
                    ) : undefined
                  }
                  onSelect={readOnly ? undefined : () => onSelect(action)}
                  selected={!readOnly && action.id === selectedId}
                />
              );
            })}
          </List>
        </ListGroup>
      ))}
    </div>
  );
}
