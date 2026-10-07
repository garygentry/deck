import type { HostCollectionState } from "@deck/server";
import type { JSX } from "react";
import { useId, useMemo, useRef, useState } from "react";
import { DataTable, type ColumnDef, type FacetOption } from "@/ui";
import {
  HOST_STATE_UI,
  HOST_STATUS_UI,
  renderHostState,
  renderMarker,
} from "../components/HostStateChip.js";
import {
  InventoryFilterBar,
  InventoryListPage,
  LIST_CELLS,
  renderRowName,
  useClearWhenUnavailable,
  useInventoryListKeyboard,
} from "../components/InventoryList.js";
import { compareOrdinal, hostHref, type HostRow } from "../model.js";
import {
  filterHosts,
  NO_HOST_FILTERS,
  type HostFilterCriteria,
} from "../search-filter.js";
import {
  InventoryDataProvider,
  useInventoryDataContext,
} from "../use-inventory-data.js";

/** Freshness options in `HOST_STATE_UI` union order (fresh…never-collected). */
const FRESHNESS_OPTIONS: readonly FacetOption[] = (
  Object.keys(HOST_STATE_UI) as HostCollectionState[]
).map((state) => ({ value: state, label: HOST_STATE_UI[state].label, icon: HOST_STATE_UI[state].icon }));

/**
 * The six leaf columns under their intent/reality groups. Module-level, so the
 * table never rebuilds its column model on a render.
 */
const HOST_COLUMNS: ColumnDef<HostRow>[] = [
  {
    id: "host",
    header: "Host",
    columns: [{ id: "name", header: "Name", cell: ({ row }) => hostName(row.original) }],
  },
  {
    id: "intent",
    header: "Declared intent",
    columns: [
      {
        id: "kind",
        header: "Kind",
        cell: ({ row }) => row.original.declared?.kind ?? LIST_CELLS.notDeclared,
      },
      {
        id: "purpose",
        header: "Purpose",
        meta: { className: "min-w-48 whitespace-normal" },
        cell: ({ row }) => row.original.declared?.purpose ?? LIST_CELLS.notDeclared,
      },
      {
        id: "declared-services",
        header: "Declared services",
        cell: ({ row }) =>
          row.original.declared !== null ? String(row.original.declaredServiceCount) : LIST_CELLS.notDeclared,
      },
    ],
  },
  {
    id: "reality",
    header: "Observed reality",
    columns: [
      {
        id: "collection",
        header: "Collection",
        meta: { className: "min-w-52 whitespace-normal" },
        cell: ({ row }) =>
          row.original.hostState !== null ? renderHostState(row.original.hostState) : LIST_CELLS.noSnapshot,
      },
      {
        id: "observed-services",
        header: "Observed services",
        cell: ({ row }) =>
          row.original.reality === "available" ? String(row.original.observedServiceCount) : LIST_CELLS.noSnapshot,
      },
    ],
  },
];

const hostRowId = (row: HostRow): string => row.key;

/** Registered `/hosts` page; owns one aggregate inventory polling context. */
export function HostsPage(): JSX.Element {
  return (
    <InventoryDataProvider>
      <HostsList />
    </InventoryDataProvider>
  );
}

/**
 * The `/hosts` truth view. Reads the shared inventory context; renders local
 * search/filter controls, the always-present count, and the six-column table.
 * It never fetches, sorts, or derives host state — the committed model is
 * authoritative and only the visible projection changes locally.
 */
function HostsList(): JSX.Element {
  const data = useInventoryDataContext();
  const { snapshot, model } = data;
  const [criteria, setCriteria] = useState<HostFilterCriteria>(NO_HOST_FILTERS);
  const searchId = useId();
  const regionRef = useRef<HTMLDivElement>(null);

  const snapshotAvailable = snapshot.status === "available";
  useClearWhenUnavailable(snapshotAvailable, criteria.states.length > 0, () =>
    setCriteria((value) => ({ ...value, states: [] })),
  );

  const rows: readonly HostRow[] = model?.hosts ?? [];
  const filtered = useMemo(() => filterHosts(rows, criteria), [rows, criteria]);

  const kindOptions = useMemo((): FacetOption[] => {
    const set = new Set<string>();
    for (const row of rows) {
      if (row.declared?.kind !== undefined) set.add(row.declared.kind);
    }
    return [...set].sort(compareOrdinal).map((kind) => ({ value: kind, label: kind }));
  }, [rows]);

  const keyboard = useInventoryListKeyboard({
    regionRef,
    searchId,
    visibleCount: filtered.rows.length,
    hasQuery: criteria.query !== "",
    clearQuery: () => setCriteria((value) => ({ ...value, query: "" })),
  });

  return (
    <InventoryListPage title="Hosts" slot="hosts-page" data={data}>
      <InventoryFilterBar
        label="Host filters"
        searchLabel="Search hosts"
        searchId={searchId}
        query={criteria.query}
        onQueryChange={(query) => setCriteria((value) => ({ ...value, query }))}
        onSearchKeyDown={keyboard.onSearchKeyDown}
        facets={[
          {
            title: "Kind",
            chipLabel: "kind",
            options: kindOptions,
            selected: criteria.kinds,
            onChange: (kinds) => setCriteria((value) => ({ ...value, kinds })),
          },
          {
            title: "Freshness",
            chipLabel: "freshness",
            options: FRESHNESS_OPTIONS,
            selected: criteria.states,
            onChange: (states) =>
              setCriteria((value) => ({ ...value, states: states as HostCollectionState[] })),
            disabled: !snapshotAvailable,
          },
        ]}
        excludeHiddenLabel="Exclude hidden hosts"
        excludeHidden={criteria.excludeHidden}
        onExcludeHiddenChange={(excludeHidden) => setCriteria((value) => ({ ...value, excludeHidden }))}
        onClearFacets={() => setCriteria((value) => ({ ...NO_HOST_FILTERS, query: value.query }))}
        shown={filtered.rows.length}
        total={filtered.total}
      />
      <div ref={regionRef} onFocus={keyboard.onRegionFocus}>
        <DataTable
          caption="Hosts inventory: declared intent beside observed reality"
          columns={HOST_COLUMNS}
          data={filtered.rows}
          getRowId={hostRowId}
          stickyHeader={false}
          empty={
            rows.length === 0
              ? "No hosts are declared or observed."
              : "No hosts match the current search and filters."
          }
        />
      </div>
    </InventoryListPage>
  );
}

/** The Name row header: the host link plus its Undeclared, lifecycle and Hidden markers. */
function hostName(row: HostRow): JSX.Element {
  const status = row.declared?.status;
  return renderRowName({
    href: hostHref(row.key),
    rowId: row.key,
    name: row.key,
    markers: (
      <>
        {row.declared === null ? LIST_CELLS.undeclared : null}
        {status !== undefined ? renderMarker(HOST_STATUS_UI[status]) : null}
        {row.declared?.hidden === true ? LIST_CELLS.hidden : null}
      </>
    ),
  });
}
