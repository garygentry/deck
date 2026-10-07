import type { JSX } from "react";
import { useId, useMemo, useRef, useState } from "react";
import { DataTable, type ColumnDef, type FacetOption } from "@/ui";
import {
  INVENTORY_MARKER_UI,
  SERVICE_STATE_UI,
  renderHostState,
} from "../components/HostStateChip.js";
import {
  InventoryFilterBar,
  InventoryListPage,
  LIST_CELLS,
  renderRowName,
  renderServiceLifecycle,
  renderServiceObservedState,
  useClearWhenUnavailable,
  useInventoryListKeyboard,
} from "../components/InventoryList.js";
import { compareOrdinal, hostHref, serviceHref, type ServiceRow } from "../model.js";
import {
  filterServices,
  NO_SERVICE_FILTERS,
  type ObservedStateFilter,
  type ServiceFilterCriteria,
} from "../search-filter.js";
import {
  InventoryDataProvider,
  useInventoryDataContext,
} from "../use-inventory-data.js";

/** Observed-state options: the four `SERVICE_STATE_UI` states plus Not observed. */
const OBSERVED_STATE_OPTIONS: readonly FacetOption[] = [
  ...(["running", "stopped", "degraded", "unknown"] as const).map((state) => ({
    value: state,
    label: SERVICE_STATE_UI[state].label,
    icon: SERVICE_STATE_UI[state].icon,
  })),
  {
    value: "not-observed",
    label: INVENTORY_MARKER_UI["not-observed"].label,
    icon: INVENTORY_MARKER_UI["not-observed"].icon,
  },
];

/**
 * A row's stable id: host and name each encoded, so the pair can never collide
 * (the same service name exists on several hosts).
 */
const serviceRowId = (row: ServiceRow): string =>
  `${encodeURIComponent(row.key.host)}/${encodeURIComponent(row.key.name)}`;

/**
 * The seven leaf columns under their service/intent/reality groups.
 * Module-level, so the table never rebuilds its column model on a render.
 */
const SERVICE_COLUMNS: ColumnDef<ServiceRow>[] = [
  {
    id: "service",
    header: "Service",
    columns: [
      { id: "name", header: "Name", cell: ({ row }) => serviceName(row.original) },
      {
        id: "host",
        header: "Host",
        cell: ({ row }) => (
          <a
            href={hostHref(row.original.key.host)}
            className="text-primary underline-offset-4 outline-none hover:underline focus-visible:rounded-sm focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            {row.original.key.host}
          </a>
        ),
      },
    ],
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
      { id: "lifecycle", header: "Lifecycle", cell: ({ row }) => renderServiceLifecycle(row.original.declared) },
      {
        id: "purpose",
        header: "Purpose",
        meta: { className: "min-w-48 whitespace-normal" },
        cell: ({ row }) => row.original.declared?.purpose ?? LIST_CELLS.notDeclared,
      },
    ],
  },
  {
    id: "reality",
    header: "Observed reality",
    columns: [
      { id: "observed-state", header: "Observed state", cell: ({ row }) => renderServiceObservedState(row.original) },
      {
        id: "host-collection",
        header: "Host collection",
        meta: { className: "min-w-52 whitespace-normal" },
        cell: ({ row }) =>
          row.original.hostState !== null ? renderHostState(row.original.hostState) : LIST_CELLS.noSnapshot,
      },
    ],
  },
];

/** Registered `/services` page; owns one aggregate inventory polling context. */
export function ServicesPage(): JSX.Element {
  return (
    <InventoryDataProvider>
      <ServicesList />
    </InventoryDataProvider>
  );
}

/**
 * The `/services` truth view. Reads the shared inventory context; renders local
 * search/filter controls, the always-present count, and the seven-column table.
 * It never fetches, sorts, or derives service or host state — the committed model
 * is authoritative and only the visible projection changes locally. Host and name
 * identity stay independent: neither links nor lookups concatenate the `(host,name)`
 * pair.
 */
function ServicesList(): JSX.Element {
  const data = useInventoryDataContext();
  const { snapshot, model } = data;
  const [criteria, setCriteria] = useState<ServiceFilterCriteria>(NO_SERVICE_FILTERS);
  const searchId = useId();
  const regionRef = useRef<HTMLDivElement>(null);

  const snapshotAvailable = snapshot.status === "available";
  useClearWhenUnavailable(snapshotAvailable, criteria.observedStates.length > 0, () =>
    setCriteria((value) => ({ ...value, observedStates: [] })),
  );

  const rows: readonly ServiceRow[] = model?.services ?? [];
  const filtered = useMemo(() => filterServices(rows, criteria), [rows, criteria]);

  // Distinct row hosts, sorted ordinally, for the Host facet.
  const hostOptions = useMemo((): FacetOption[] => {
    const set = new Set<string>();
    for (const row of rows) set.add(row.key.host);
    return [...set].sort(compareOrdinal).map((host) => ({ value: host, label: host }));
  }, [rows]);

  const keyboard = useInventoryListKeyboard({
    regionRef,
    searchId,
    visibleCount: filtered.rows.length,
    hasQuery: criteria.query !== "",
    clearQuery: () => setCriteria((value) => ({ ...value, query: "" })),
  });

  return (
    <InventoryListPage title="Services" slot="services-page" data={data}>
      <InventoryFilterBar
        label="Service filters"
        searchLabel="Search services"
        searchId={searchId}
        query={criteria.query}
        onQueryChange={(query) => setCriteria((value) => ({ ...value, query }))}
        onSearchKeyDown={keyboard.onSearchKeyDown}
        facets={[
          {
            title: "Host",
            chipLabel: "host",
            options: hostOptions,
            selected: criteria.hosts,
            onChange: (hosts) => setCriteria((value) => ({ ...value, hosts })),
          },
          {
            title: "Observed state",
            chipLabel: "observed state",
            options: OBSERVED_STATE_OPTIONS,
            selected: criteria.observedStates,
            onChange: (states) =>
              setCriteria((value) => ({ ...value, observedStates: states as ObservedStateFilter[] })),
            disabled: !snapshotAvailable,
          },
        ]}
        excludeHiddenLabel="Exclude hidden services"
        excludeHidden={criteria.excludeHidden}
        onExcludeHiddenChange={(excludeHidden) => setCriteria((value) => ({ ...value, excludeHidden }))}
        onClearFacets={() => setCriteria((value) => ({ ...NO_SERVICE_FILTERS, query: value.query }))}
        shown={filtered.rows.length}
        total={filtered.total}
      />
      <div ref={regionRef} onFocus={keyboard.onRegionFocus}>
        <DataTable
          caption="Services inventory: declared intent beside observed reality"
          columns={SERVICE_COLUMNS}
          data={filtered.rows}
          getRowId={serviceRowId}
          stickyHeader={false}
          empty={
            rows.length === 0
              ? "No services are declared or observed."
              : "No services match the current search and filters."
          }
        />
      </div>
    </InventoryListPage>
  );
}

/** The Name row header: the service link plus its Undeclared and Hidden markers. */
function serviceName(row: ServiceRow): JSX.Element {
  return renderRowName({
    href: serviceHref(row.key.host, row.key.name),
    rowId: serviceRowId(row),
    name: row.key.name,
    markers: (
      <>
        {row.declared === null ? LIST_CELLS.undeclared : null}
        {row.declared?.hidden === true ? LIST_CELLS.hidden : null}
      </>
    ),
  });
}
