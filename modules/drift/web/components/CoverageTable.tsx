import { DRIFT_UI_DEFAULTS } from "@deck/drift";
import type { CoverageRow } from "@deck/drift";
import { useMemo, type JSX } from "react";
import {
  Button,
  DataTable,
  Disclosure,
  EmptyValue,
  StatusBadge,
  formatAge,
  type ColumnDef,
} from "@/ui";
import type { InventoryModel } from "../../hosts-and-services/model.js";
import { DRIFT_COVERAGE } from "../constants.js";
import { resolveHostHref } from "../shared.js";
import { EntityLink } from "./FindingRow.js";

/** Complete host-coverage renderer with one page-wide progressive bound. */
export interface CoverageTableProps {
  /** Filtered attention-ordered rows from the accepted projection. */
  readonly rows: readonly CoverageRow[];
  /** Matching accepted model used only for host route resolution. */
  readonly model: InventoryModel;
  /** Display-only clock used to advance relative ages without changing state. */
  readonly now: Date;
  /** Number of currently rendered rows, clamped to `rows.length`. */
  readonly visibleCount: number;
  /** Increase the visible bound by `additionalRowsPerStep`. */
  readonly onShowMore: () => void;
  /** Reveal every filtered coverage row. */
  readonly onShowAll: () => void;
}

/**
 * Collision-safe, stable result id for one coverage row. `encodeURIComponent` is
 * injective and hosts are unique within a generation, so distinct rows never
 * collide; the namespaced prefix keeps the id valid for programmatic focus and
 * distinct from finding result ids. A host carrying lone surrogates (a defensive
 * in-memory identity) falls back to an injective hex encoding that never throws.
 */
export function coverageResultId(host: string): string {
  let encoded: string;
  try {
    encoded = encodeURIComponent(host);
  } catch {
    encoded = Array.from(host, (char) =>
      (char.codePointAt(0) ?? 0).toString(16),
    ).join("-");
  }
  return `drift-coverage-${encoded}`;
}

/**
 * Display-time age from the page clock, or null for a null/unparseable timestamp.
 * This advances relative text only; it never recalculates `state`,
 * `pastStaleThreshold`, ordering, or any summary count.
 */
function displayAgeMs(collectedAt: string | null, now: Date): number | null {
  if (collectedAt === null) return null;
  const epoch = Date.parse(collectedAt);
  if (!Number.isFinite(epoch)) return null;
  return Math.max(0, now.getTime() - epoch);
}

/** The exact fixed cell text for a row with no valid collection timestamp. */
function missingTimestampText(row: CoverageRow): string {
  if (row.state === "unreachable") return "No collection timestamp";
  if (row.state === "never-collected") return "No collection has been recorded";
  return "Collection timestamp unavailable";
}

/** The collector-failures cell: a disclosure for a partial host, else fixed text. */
function CollectorFailures({ row }: { readonly row: CoverageRow }): JSX.Element {
  if (row.state !== "partial") return <EmptyValue>Not applicable</EmptyValue>;
  if (row.failedCollectors.length === 0) {
    return <EmptyValue>No failed collector details were supplied.</EmptyValue>;
  }
  return (
    <Disclosure label={`${row.failedCollectors.length} failed collectors`}>
      <ul className="m-0 flex list-none flex-col gap-1 p-0 text-xs">
        {row.failedCollectors.map((failure, index) => (
          <li key={index} className="break-words">
            <span className="font-medium">{failure.name}</span>: {failure.reason}
          </li>
        ))}
      </ul>
    </Disclosure>
  );
}

/** Build the table's columns; the display clock and model are closed over. */
function coverageColumns(model: InventoryModel, now: Date): ColumnDef<CoverageRow>[] {
  return [
    {
      id: "host",
      header: "Host",
      cell: ({ row: { original } }) => {
        const href = resolveHostHref(model, original.host);
        return href !== null ? (
          <EntityLink href={href} primary>
            {original.host}
          </EntityLink>
        ) : (
          <span className="flex flex-col">
            <span>{original.host}</span>
            <EmptyValue className="text-xs">Host detail link unresolved</EmptyValue>
          </span>
        );
      },
    },
    {
      id: "state",
      header: "Collection state",
      cell: ({ row: { original } }) => StatusBadge.fromMap(DRIFT_COVERAGE, original.state),
    },
    {
      id: "collectedAt",
      header: "Collected at",
      meta: { className: "whitespace-nowrap" },
      cell: ({ row: { original } }) =>
        original.collectedAt !== null && Number.isFinite(Date.parse(original.collectedAt)) ? (
          <time dateTime={original.collectedAt}>{original.collectedAt}</time>
        ) : (
          <EmptyValue>{missingTimestampText(original)}</EmptyValue>
        ),
    },
    {
      id: "age",
      header: "Age",
      meta: { className: "whitespace-nowrap" },
      cell: ({ row: { original } }) => {
        const ageMs = displayAgeMs(original.collectedAt, now);
        return ageMs === null ? <EmptyValue>Age unavailable</EmptyValue> : formatAge(ageMs);
      },
    },
    {
      id: "collectors",
      header: "Collector failures",
      meta: { className: "min-w-48 align-top" },
      cell: ({ row: { original } }) => <CollectorFailures row={original} />,
    },
  ];
}

/**
 * Render every filtered coverage row in authoritative attention order through one
 * semantic table with caption and column headers. Only the first `visibleCount`
 * rows mount, with page-owned show-more/show-all disclosure that always describes
 * the complete filtered array. The component never re-sorts, reclassifies, or
 * derives a total from the visible slice.
 */
export function CoverageTable({
  rows,
  model,
  now,
  visibleCount,
  onShowMore,
  onShowAll,
}: CoverageTableProps): JSX.Element {
  const total = rows.length;
  const visible = Math.min(Math.max(0, visibleCount), total);
  const remaining = total - visible;
  const more = Math.min(DRIFT_UI_DEFAULTS.additionalRowsPerStep, remaining);
  const columns = useMemo(() => coverageColumns(model, now), [model, now]);
  const data = useMemo(() => rows.slice(0, visible), [rows, visible]);

  return (
    <div className="flex flex-col gap-3">
      <DataTable
        columns={columns}
        data={data}
        caption="Host collection coverage; attention states precede fresh hosts. Order: Unreachable, Never collected, Partial, Stale, Fresh."
        getRowId={(row) => row.host}
        rowDomId={(row) => coverageResultId(row.host)}
        stickyHeader={false}
        empty="No coverage hosts match the current scope and filters."
      />
      {remaining > 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => onShowMore()}>
            Show {more} more coverage hosts
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => onShowAll()}>
            Show all {total} coverage hosts
          </Button>
        </div>
      ) : null}
    </div>
  );
}
