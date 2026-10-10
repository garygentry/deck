import type { JSX, KeyboardEvent as ReactKeyboardEvent, ReactNode, RefObject } from "react";
import { useCallback, useEffect, useId, useRef } from "react";
import {
  ActiveFilters,
  Checkbox,
  ErrorState,
  FacetFilter,
  FilterBar,
  focusIsLost,
  Label,
  LoadingState,
  PageHeader,
  ROW_LINK_ATTRIBUTE,
  ROW_LINK_SELECTOR,
  ResultCount,
  SearchInput,
  pageHeadingId,
  useListNavigation,
  type ActiveFilter,
  type FacetOption,
} from "@/ui";
import type { InventoryData } from "../use-inventory-data.js";
import type { ServiceRow } from "../model.js";
import {
  INVENTORY_MARKER_UI,
  SERVICE_STATE_UI,
  SERVICE_STATUS_UI,
  renderAbsent,
  renderMarker,
} from "./HostStateChip.js";
import { SnapshotStatus } from "./SnapshotStatus.js";

// ---------------------------------------------------------------------------
// Shared scaffolding for the two inventory list pages (/hosts, /services): the
// page frame, the filter bar, the row-name cell and the keyboard model. Each
// page supplies only its columns, filter facets and filter projection.
// ---------------------------------------------------------------------------

export interface InventoryListPageProps {
  /** The page title and `h1` ("Hosts"). */
  title: string;
  /** `data-slot` of the page root, so the whole page gets Tailwind Preflight. */
  slot: string;
  data: InventoryData;
  /** The filter bar and table; rendered only once a model has committed. */
  children: ReactNode;
}

/**
 * The page frame: heading, snapshot status, and the loading / config-error
 * ladder. The snapshot diagnosis renders in every branch, independently of the
 * config, so a config failure never hides a snapshot failure.
 */
export function InventoryListPage({ title, slot, data, children }: InventoryListPageProps): JSX.Element {
  const { configError, snapshot, model, loading } = data;
  return (
    <section
      data-slot={slot}
      aria-labelledby={pageHeadingId(title)}
      className="flex flex-col gap-4"
    >
      <PageHeader title={title} />
      <SnapshotStatus snapshot={snapshot} />
      {model === null ? (
        loading ? (
          <LoadingState label="Loading inventory…" preset="table" />
        ) : (
          <ErrorState
            title={`Inventory configuration unavailable: ${configError ?? "Unknown configuration error"}`}
          />
        )
      ) : (
        children
      )}
    </section>
  );
}

/** One facet of the filter bar: a popover multi-select. */
export interface InventoryFacet {
  title: string;
  /** Lower-case noun for the active-filter chip ("kind"). */
  chipLabel: string;
  options: readonly FacetOption[];
  selected: readonly string[];
  onChange: (next: string[]) => void;
  /**
   * Reality facets are disabled (and explained) while no snapshot is available,
   * so a filter the user can no longer see never hides rows.
   */
  disabled?: boolean;
}

export interface InventoryFilterBarProps {
  /** Accessible name of the search landmark. */
  label: string;
  searchLabel: string;
  searchId: string;
  query: string;
  onQueryChange: (query: string) => void;
  onSearchKeyDown: (event: ReactKeyboardEvent<HTMLInputElement>) => void;
  facets: readonly InventoryFacet[];
  excludeHiddenLabel: string;
  excludeHidden: boolean;
  onExcludeHiddenChange: (next: boolean) => void;
  /** Resets every facet and the exclude-hidden toggle. */
  onClearFacets: () => void;
  shown: number;
  total: number;
}

/** Stop keys typed inside a facet popover (portalled) from reaching the row navigation. */
function isolateKeys(event: ReactKeyboardEvent): void {
  event.stopPropagation();
}

/**
 * The shared filter bar: a search field, one popover facet per filter
 * dimension, the exclude-hidden checkbox, removable chips for the selected
 * facet values and the polite "Showing X of Y" count.
 */
export function InventoryFilterBar({
  label,
  searchLabel,
  searchId,
  query,
  onQueryChange,
  onSearchKeyDown,
  facets,
  excludeHiddenLabel,
  excludeHidden,
  onExcludeHiddenChange,
  onClearFacets,
  shown,
  total,
}: InventoryFilterBarProps): JSX.Element {
  const excludeId = useId();
  const unavailable = facets.some((facet) => facet.disabled === true);

  const chips: ActiveFilter[] = [];
  for (const facet of facets) {
    for (const value of facet.selected) {
      const option = facet.options.find((entry) => entry.value === value);
      chips.push({
        id: `${facet.title}:${value}`,
        facet: facet.title,
        facetLabel: facet.chipLabel,
        value,
        label: option?.label ?? value,
      });
    }
  }
  if (excludeHidden) {
    chips.push({ id: "exclude-hidden", facetLabel: "visibility", value: "hidden", label: "Hidden excluded" });
  }

  const removeChip = (chip: ActiveFilter): void => {
    if (chip.facet === undefined) {
      onExcludeHiddenChange(false);
      return;
    }
    const facet = facets.find((entry) => entry.title === chip.facet);
    facet?.onChange(facet.selected.filter((value) => value !== chip.value));
  };

  return (
    <FilterBar
      label={label}
      search={
        <SearchInput
          id={searchId}
          label={searchLabel}
          placeholder={`${searchLabel}…`}
          value={query}
          onValueChange={onQueryChange}
          onKeyDown={onSearchKeyDown}
        />
      }
      activeFilters={
        <ActiveFilters filters={chips} onRemove={removeChip} onClearAll={onClearFacets} />
      }
      resultCount={<ResultCount shown={shown} total={total} />}
    >
      <div className="contents" onKeyDown={isolateKeys}>
        {facets.map((facet) => (
          <fieldset key={facet.title} disabled={facet.disabled === true} className="contents">
            <FacetFilter
              title={facet.title}
              variant="popover"
              options={facet.options}
              selected={new Set(facet.selected)}
              onSelectedChange={(next) =>
                // Keep the option order stable, whatever order values were picked in.
                facet.onChange(facet.options.map((o) => o.value).filter((v) => next.has(v)))
              }
            />
          </fieldset>
        ))}
        <div className="flex h-8 items-center gap-2">
          <Checkbox
            id={excludeId}
            checked={excludeHidden}
            onCheckedChange={(checked) => onExcludeHiddenChange(checked === true)}
          />
          <Label htmlFor={excludeId} className="font-normal">
            {excludeHiddenLabel}
          </Label>
        </div>
        {unavailable ? (
          <p className="flex h-8 items-center text-sm text-muted-foreground">
            Snapshot data is unavailable.
          </p>
        ) : null}
      </div>
    </FilterBar>
  );
}

export interface RowNameProps {
  href: string;
  /** Row id: the `data-row-link` value `useListNavigation` targets. */
  rowId: string;
  name: string;
  /** Row annotations (Undeclared, lifecycle, Hidden) after the link. */
  markers?: ReactNode;
}

/**
 * The first (row-header) cell: the entity link, then its markers. The link is
 * rendered here rather than through `DataTable`'s `rowLink`, so the markers stay
 * outside the link's accessible name. A render function, not a component: the
 * tables render one per row.
 */
export function renderRowName({ href, rowId, name, markers }: RowNameProps): JSX.Element {
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <a
        href={href}
        {...{ [ROW_LINK_ATTRIBUTE]: rowId }}
        className="font-medium text-primary underline-offset-4 outline-none hover:underline focus-visible:rounded-sm focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        {name}
      </a>
      {markers}
    </span>
  );
}

/**
 * The fixed cell values the tables repeat on many rows, built once. React
 * renders a shared element at every place it appears, so a 300-row table does
 * not rebuild the same markup 300 times.
 */
export const LIST_CELLS = {
  notDeclared: renderAbsent(INVENTORY_MARKER_UI["not-declared"]),
  noSnapshot: renderAbsent(INVENTORY_MARKER_UI["no-snapshot"]),
  notObserved: renderAbsent(INVENTORY_MARKER_UI["not-observed"]),
  unspecified: renderAbsent(INVENTORY_MARKER_UI.unspecified),
  undeclared: renderMarker(INVENTORY_MARKER_UI.undeclared, "outline"),
  hidden: renderMarker(INVENTORY_MARKER_UI.hidden, "outline"),
} as const;

/** Declared service lifecycle: exact status, `Unspecified` when omitted, or `Not declared`. */
export function renderServiceLifecycle(declared: ServiceRow["declared"]): JSX.Element {
  if (declared === null) return LIST_CELLS.notDeclared;
  if (declared.status === undefined) return LIST_CELLS.unspecified;
  return renderMarker(SERVICE_STATUS_UI[declared.status]);
}

/**
 * Observed service state: the exhaustive `SERVICE_STATE_UI` marker when observed,
 * `Not observed` when reality is available but no observation exists, and
 * `No snapshot` when reality is unavailable. Never coerced to Stopped/Unknown.
 */
export function renderServiceObservedState(row: ServiceRow): JSX.Element {
  if (row.reality !== "available") return LIST_CELLS.noSnapshot;
  if (row.observed !== null) return renderMarker(SERVICE_STATE_UI[row.observed.state]);
  return LIST_CELLS.notObserved;
}

export interface InventoryListKeyboardOptions {
  /** Wraps the table; the row links inside it are the navigable items. */
  regionRef: RefObject<HTMLElement | null>;
  /** The search input's DOM id. */
  searchId: string;
  /** The number of visible rows (after filtering). */
  visibleCount: number;
  /** Whether the search query is non-empty. */
  hasQuery: boolean;
  /** Clear the search query. */
  clearQuery: () => void;
}

export interface InventoryListKeyboard {
  /** The search field's key handler (Escape clears and returns focus to a row). */
  onSearchKeyDown: (event: ReactKeyboardEvent<HTMLInputElement>) => void;
  /** Put on the table wrapper: remembers which row link last held focus. */
  onRegionFocus: (event: { target: EventTarget }) => void;
}

/**
 * The list pages' keyboard model on `useListNavigation` (vim preset):
 * `/` and Ctrl/Cmd-K focus search; j/k, arrows, Home/End, gg/G move between row
 * links; Enter opens the focused row, or the first row from search; Escape in
 * search clears the query and returns focus to a row (no search trap).
 *
 * When filtering changes the visible row count and the row that last held focus
 * is gone, focus is recovered onto the first visible row — unless the user is
 * typing in search.
 */
export function useInventoryListKeyboard({
  regionRef,
  searchId,
  visibleCount,
  hasQuery,
  clearQuery,
}: InventoryListKeyboardOptions): InventoryListKeyboard {
  const lastRowRef = useRef(-1);
  const hasQueryRef = useRef(hasQuery);
  hasQueryRef.current = hasQuery;
  const clearRef = useRef(clearQuery);
  clearRef.current = clearQuery;

  const getItems = useCallback(
    (): HTMLElement[] => [
      ...(regionRef.current?.querySelectorAll<HTMLElement>(ROW_LINK_SELECTOR) ?? []),
    ],
    [regionRef],
  );
  const getSearch = useCallback(() => document.getElementById(searchId), [searchId]);

  /** Clear the query and move focus to the last focused row, or the first. */
  const clearAndFocusRow = useCallback((): void => {
    const items = getItems();
    const index = lastRowRef.current;
    clearRef.current();
    (items[index] ?? items[0])?.focus();
  }, [getItems]);

  useListNavigation({
    getItems,
    getSearch,
    activateFirstFromSearch: true,
    onEscape: () => {
      const search = getSearch();
      if (!hasQueryRef.current && (search === null || document.activeElement !== search)) {
        return false;
      }
      clearAndFocusRow();
      return true;
    },
  });

  const prevCountRef = useRef(visibleCount);
  useEffect(() => {
    const prev = prevCountRef.current;
    prevCountRef.current = visibleCount;
    if (prev === visibleCount) return;
    const last = lastRowRef.current;
    if (last < 0) return;
    if (visibleCount === 0) {
      lastRowRef.current = -1;
      return;
    }
    if (last < visibleCount) return;
    lastRowRef.current = 0;
    // Only rescue focus the vanished row took with it. Never steal it from
    // search, a filter popover, or the exclude-hidden checkbox.
    if (!focusIsLost()) return;
    getItems()[0]?.focus();
  }, [visibleCount, getItems]);

  const onSearchKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>): void => {
      if (event.key !== "Escape" || event.nativeEvent.isComposing) return;
      // Claim Escape before SearchInput's own clear, so focus returns to a row.
      event.preventDefault();
      clearAndFocusRow();
    },
    [clearAndFocusRow],
  );

  const onRegionFocus = useCallback(
    (event: { target: EventTarget }): void => {
      const index = getItems().indexOf(event.target as HTMLElement);
      if (index >= 0) lastRowRef.current = index;
    },
    [getItems],
  );

  return { onSearchKeyDown, onRegionFocus };
}

/**
 * Clear a reality filter when the snapshot stops being available: otherwise
 * every row could silently disappear behind a filter the user can no longer
 * see or change.
 */
export function useClearWhenUnavailable(available: boolean, active: boolean, clear: () => void): void {
  const clearRef = useRef(clear);
  clearRef.current = clear;
  useEffect(() => {
    if (!available && active) clearRef.current();
  }, [available, active]);
}
