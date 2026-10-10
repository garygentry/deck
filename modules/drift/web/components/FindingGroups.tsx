import { DRIFT_UI_DEFAULTS } from "@deck/drift";
import type { FindingHostGroup } from "@deck/drift";
import type { JSX } from "react";
import { Button, List, ListGroup } from "@/ui";
import type { InventoryModel } from "../../../inventory/web/model.js";
import { FindingRow } from "./FindingRow.js";

/** Grouped complete-result renderer with independent progressive group bounds. */
export interface FindingGroupsProps {
  /** Filtered groups retaining projection-defined order. */
  readonly groups: readonly FindingHostGroup[];
  /** Matching accepted inventory model used only for route resolution. */
  readonly model: InventoryModel;
  /** Visible count by collision-safe host/subgroup key. */
  readonly visibleByGroup: ReadonlyMap<string, number>;
  /** Increase one group by `additionalRowsPerStep`. */
  readonly onShowMore: (groupKey: string) => void;
  /** Reveal every row in exactly one group. */
  readonly onShowAll: (groupKey: string) => void;
}

/** Collision-free subgroup key; never concatenated with a delimiter. */
export function findingSubgroupKey(host: string, service: string | null): string {
  return JSON.stringify([host, service]);
}

/** Human-readable subgroup identity used in disclosure control names. */
function subgroupLabel(host: string, service: string | null): string {
  return service === null
    ? `Host-level findings on ${host}`
    : `${service} on ${host}`;
}

/**
 * Collision-safe, stable result id for one finding. `encodeURIComponent` is
 * injective, so distinct finding ids never collide, and the namespaced prefix
 * keeps ids valid for programmatic focus.
 */
export function findingResultId(id: string): string {
  return `drift-finding-${encodeURIComponent(id)}`;
}

/**
 * Render host groups in immutable projection order, each with a host-level
 * subgroup first and then ordinal service subgroups. Every host/subgroup heading
 * and complete count is always present; only the first `visibleByGroup` rows of
 * each subgroup mount, with controlled show-more/show-all disclosure that reaches
 * every finding. This renderer never re-sorts or slices source totals.
 */
export function FindingGroups({
  groups,
  model,
  visibleByGroup,
  onShowMore,
  onShowAll,
}: FindingGroupsProps): JSX.Element {
  return (
    <div className="flex flex-col gap-4">
      {groups.map((group) => (
        <ListGroup
          key={group.host}
          level={3}
          heading={`Host: ${group.host}`}
          description={`${group.findingCount} findings in this host group`}
          className="rounded-lg border bg-card p-3 text-card-foreground sm:p-4"
        >
          <div className="flex flex-col gap-4">
            {group.subgroups.map((subgroup) => {
              const key = findingSubgroupKey(group.host, subgroup.service);
              const total = subgroup.findings.length;
              const initial = Math.min(DRIFT_UI_DEFAULTS.initialRowsPerGroup, total);
              const visible = Math.min(visibleByGroup.get(key) ?? initial, total);
              const remaining = total - visible;
              const more = Math.min(DRIFT_UI_DEFAULTS.additionalRowsPerStep, remaining);
              const label = subgroupLabel(group.host, subgroup.service);
              return (
                <ListGroup
                  key={key}
                  level={4}
                  heading={
                    subgroup.service === null
                      ? "Host-level findings"
                      : `Service: ${subgroup.service}`
                  }
                >
                  <List as="ol" variant="divided">
                    {subgroup.findings.slice(0, visible).map((finding) => (
                      <FindingRow
                        key={finding.id}
                        finding={finding}
                        model={model}
                        resultId={findingResultId(finding.id)}
                      />
                    ))}
                  </List>
                  {remaining > 0 ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        aria-label={`Show ${more} more findings in ${label}`}
                        onClick={() => onShowMore(key)}
                      >
                        Show {more} more findings
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => onShowAll(key)}
                      >
                        Show all {total} findings in {label}
                      </Button>
                    </div>
                  ) : null}
                </ListGroup>
              );
            })}
          </div>
        </ListGroup>
      ))}
    </div>
  );
}
