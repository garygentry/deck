import { DRIFT_UI_DEFAULTS, filterDriftProjection } from "@deck/server";
import type {
  DriftFilters,
  DriftProjection,
  FilteredDriftProjection,
} from "@deck/server";
import type { JSX, ReactNode, Ref } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Button,
  Callout,
  EmptyState,
  ErrorState,
  LoadingState,
  PageErrorBoundary,
  focusIsLost,
  PageHeader,
  Section,
  VisuallyHidden,
  nearestSurvivor,
  useListNavigation,
} from "@/ui";
import { useLocation } from "@/shell/router";
import { reportDriftRenderTransition } from "./diagnostics.js";
import { nextProgressiveCount } from "./constants.js";
import {
  FilterBar,
  emptyDriftFilters,
  hasLocalCriteria,
} from "./components/FilterBar.js";
import type { DriftEntityFilterOption } from "./components/FilterBar.js";
import { DriftOverview } from "./components/DriftOverview.js";
import {
  FindingGroups,
  findingResultId,
  findingSubgroupKey,
} from "./components/FindingGroups.js";
import { CoverageTable, coverageResultId } from "./components/CoverageTable.js";
import { parseDriftScope, resolveDriftScope } from "./scope.js";
import type { DriftScopeResult } from "./scope.js";
import { classifyNoGeneration, hasRetainedFailure } from "./shared.js";
import { getDriftGeneration } from "./store.js";
import type {
  AcceptedDriftGeneration,
  DriftGenerationState,
} from "./store.js";
import { useDriftGeneration } from "./use-drift-generation.js";

/** Props for the page-owned final render-isolation boundary. */
export interface DriftPageBoundaryProps {
  /** Page content isolated from the shell and primary navigation. */
  readonly children: ReactNode;
}

/**
 * Page-owned error boundary. A render/interaction throw in page content is
 * isolated here without touching the shell navigation. It reports only the fixed
 * sanitized render diagnostic (never exception text), and retry remounts the
 * content without any HTTP or write.
 */
export function DriftPageBoundary({ children }: DriftPageBoundaryProps): JSX.Element {
  return (
    <PageErrorBoundary
      title="Drift view could not be displayed"
      message="The snapshot may still be available. This display failed independently."
      retryLabel="Retry drift view"
      onError={() => reportDriftRenderTransition("page", "error", getDriftGeneration(), 0)}
    >
      {children}
    </PageErrorBoundary>
  );
}

/** Registered route component. It accepts no feature props. */
export function DriftPage(): JSX.Element {
  return (
    <DriftPageBoundary>
      <DriftPageContent />
    </DriftPageBoundary>
  );
}

/** Fixed page heading text shared by every generation state. */
const PAGE_HEADING = "Drift and collection coverage";
/** The page heading id every generation state labels its section with. */
const HEADING_ID = "drift-heading";

/**
 * The page root. `data-slot` opts the whole page out of the legacy element
 * styles, so it renders on the component library alone.
 */
function PageFrame({
  children,
  containerRef,
}: {
  readonly children: ReactNode;
  readonly containerRef?: Ref<HTMLElement>;
}): JSX.Element {
  return (
    <section
      ref={containerRef}
      data-slot="drift-page"
      aria-labelledby={HEADING_ID}
      className="flex min-w-0 flex-col gap-6"
    >
      <PageHeader id={HEADING_ID} title={PAGE_HEADING} />
      {children}
    </section>
  );
}

/**
 * Subscribe to the one shared drift generation and branch exhaustively on its
 * state. Never fetches, derives, or reads a second store.
 */
function DriftPageContent(): JSX.Element {
  const state = useDriftGeneration();
  if (state.current === null) {
    return <PageFrame>{renderUnavailableBody(state)}</PageFrame>;
  }
  return <DriftAvailable state={state} current={state.current} />;
}

/**
 * Choose the single distinct no-usable-generation surface, with distinct
 * status/alert semantics and no fabricated counts.
 */
function renderUnavailableBody(state: DriftGenerationState): JSX.Element {
  const reason = classifyNoGeneration(state);
  switch (reason.kind) {
    case "derivation-failed":
      return <ErrorState title="Drift view could not be derived." message={reason.detail} />;
    case "not-configured":
      return (
        <EmptyState
          icon="database-off"
          title="No snapshot is configured."
          description="Configure a snapshot provider to collect drift and coverage."
        />
      );
    case "read-failed":
      return (
        <ErrorState
          title="Snapshot read failed; no retained snapshot is available."
          message={reason.detail ?? undefined}
        />
      );
    case "request-failed":
      return (
        <ErrorState
          title="Snapshot request failed; no retained snapshot is available."
          message={reason.detail}
        />
      );
    case "pending":
      return (
        <Callout tone="pending" icon="hourglass">
          Waiting for the first snapshot read.
        </Callout>
      );
    case "loading":
      return <LoadingState label="Loading drift data…" />;
    case "unavailable":
      return <ErrorState title="Drift configuration is unavailable." />;
  }
}

/** Narrow a complete projection to a valid entity scope; other results pass through. */
function applyScope(
  projection: DriftProjection,
  scope: DriftScopeResult,
): DriftProjection {
  if (scope.status !== "scoped") return projection;
  const { host, service } = scope.scope;

  const findingGroups = [];
  for (const group of projection.findingGroups) {
    if (group.host !== host) continue;
    if (service === undefined) {
      findingGroups.push(group);
      continue;
    }
    const subgroups = group.subgroups.filter((sub) => sub.service === service);
    if (subgroups.length === 0) continue;
    const findingCount = subgroups.reduce(
      (total, sub) => total + sub.findings.length,
      0,
    );
    findingGroups.push(
      Object.freeze({
        host: group.host,
        subgroups: Object.freeze(subgroups),
        findingCount,
      }),
    );
  }

  const coverageRows = projection.coverageRows.filter(
    (row) => row.host === host,
  );

  return Object.freeze({
    ...projection,
    findingGroups: Object.freeze(findingGroups),
    coverageRows: Object.freeze(coverageRows),
  });
}

/** Build host and service filter options in deterministic projection order. */
function buildEntityOptions(
  projection: DriftProjection,
): DriftEntityFilterOption[] {
  const options: DriftEntityFilterOption[] = [];
  for (const group of projection.findingGroups) {
    options.push({
      token: JSON.stringify([group.host, null]),
      scope: { host: group.host },
      label: group.host,
    });
    for (const subgroup of group.subgroups) {
      if (subgroup.service === null) continue;
      options.push({
        token: JSON.stringify([group.host, subgroup.service]),
        scope: { host: group.host, service: subgroup.service },
        label: `${subgroup.service} on ${group.host}`,
      });
    }
  }
  return options;
}

/** Collect open category strings in exact code-point order. */
function buildCategories(projection: DriftProjection): string[] {
  const categories = new Set<string>();
  for (const group of projection.findingGroups) {
    for (const subgroup of group.subgroups) {
      for (const finding of subgroup.findings) categories.add(finding.category);
    }
  }
  return [...categories].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
}

/** Remove one local criterion, preserving every other criterion. */
function removeCriterion(
  filters: DriftFilters,
  facet: keyof DriftFilters,
  value?: string,
): DriftFilters {
  if (facet === "text") return { ...filters, text: "" };
  if (value === undefined) return filters;
  const current = filters[facet] as ReadonlySet<string>;
  const next = new Set(current);
  next.delete(value);
  return { ...filters, [facet]: next } as DriftFilters;
}

/** Compose the exact filtered-population status line. */
function filteredStatusText(
  filtered: FilteredDriftProjection,
  scope: DriftScopeResult,
  filters: DriftFilters,
): string {
  const counts = filtered.filtered;
  const total = filtered.total;
  let text = `Showing ${counts.findings} of ${total.totalFindings} findings across ${counts.hostsWithFindings} host groups; showing ${counts.coverageRows} of ${total.totalHosts} coverage hosts.`;
  if (scope.status === "scoped") {
    const { host, service } = scope.scope;
    text +=
      service !== undefined
        ? ` Entity scope: service ${service} on ${host}.`
        : ` Entity scope: host ${host}.`;
  }
  if (hasLocalCriteria(filters)) {
    text += " Local filters active.";
  }
  return text;
}

/**
 * The keyboard results, in DOM order: finding rows, then coverage rows. Hidden
 * progressive rows are not mounted, so they are never results.
 */
const RESULT_SELECTOR = 'li[id^="drift-finding-"], tr[id^="drift-coverage-"]';

/** The mounted keyboard results under `container`. */
function resultRows(container: ParentNode): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(RESULT_SELECTOR));
}

/** Focus the mounted row element carrying `id`; true when it was found. */
function focusResultElement(container: ParentNode, id: string): boolean {
  const el = resultRows(container).find((row) => row.id === id);
  if (el === undefined) return false;
  el.focus();
  return true;
}

/**
 * Render one accepted matching projection/model pair: warnings, complete-generation
 * overview, filter controls, the population-labelled filtered status, and the
 * qualified no-drift/no-match/scope-no-match states. Filtering is memoized and
 * pure; nothing here fetches or derives.
 */
function DriftAvailable({
  state,
  current,
}: {
  readonly state: DriftGenerationState;
  readonly current: AcceptedDriftGeneration;
}): JSX.Element {
  const location = useLocation();
  const [filters, setFilters] = useState<DriftFilters>(emptyDriftFilters);
  const [now, setNow] = useState<Date>(() => new Date());
  const [updateMessage, setUpdateMessage] = useState<string>("");

  // The page section, the last keyboard-focused result, and the result order at
  // the last reconcile. The keyboard hook reads live values through refs.
  const containerRef = useRef<HTMLElement | null>(null);
  const lastFocusedRef = useRef<string | null>(null);
  const prevVisibleRef = useRef<readonly string[]>([]);
  const pendingFocusRef = useRef<string | null>(null);
  const searchTextRef = useRef("");
  const scopeRef = useRef<DriftScopeResult | null>(null);
  const locationRef = useRef(location);

  const projection = current.projection;
  const model = current.inventory.model;

  // Display-only clock; advances relative ages without any network work.
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(id);
  }, []);

  // Announce an accepted-generation change politely without moving focus.
  const priorGeneration = useRef(current.refreshGeneration);
  useEffect(() => {
    if (priorGeneration.current !== current.refreshGeneration) {
      priorGeneration.current = current.refreshGeneration;
      setUpdateMessage("Drift data updated");
    }
  }, [current.refreshGeneration]);

  // Report one successful page-render transition per accepted generation.
  useEffect(() => {
    reportDriftRenderTransition("page", "ok", state, 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current.refreshGeneration]);

  const rawUrl = location.url;
  const parsed = useMemo<DriftScopeResult>(
    () => parseDriftScope(rawUrl),
    [rawUrl],
  );
  const scope = useMemo<DriftScopeResult>(
    () => (model !== null ? resolveDriftScope(parsed, model) : parsed),
    [parsed, model],
  );

  const scoped = useMemo(
    () => applyScope(projection, scope),
    [projection, scope],
  );
  const filtered = useMemo(
    () => filterDriftProjection(scoped, filters),
    [scoped, filters],
  );

  const entityOptions = useMemo(
    () => buildEntityOptions(projection),
    [projection],
  );
  const categories = useMemo(() => buildCategories(projection), [projection]);

  // Page-owned per-subgroup visible counts. A newly accepted generation resets all
  // disclosure to initial bounds; within a generation the override advances.
  const [groupOverrides, setGroupOverrides] = useState<
    ReadonlyMap<string, number>
  >(() => new Map());
  useEffect(() => {
    setGroupOverrides(new Map());
  }, [current.refreshGeneration]);

  const groupTotals = useMemo(() => {
    const totals = new Map<string, number>();
    for (const group of filtered.findingGroups) {
      for (const subgroup of group.subgroups) {
        totals.set(
          findingSubgroupKey(group.host, subgroup.service),
          subgroup.findings.length,
        );
      }
    }
    return totals;
  }, [filtered]);

  const visibleByGroup = useMemo(() => {
    const visible = new Map<string, number>();
    for (const [key, total] of groupTotals) {
      const initial = Math.min(DRIFT_UI_DEFAULTS.initialRowsPerGroup, total);
      const override = groupOverrides.get(key);
      visible.set(
        key,
        override === undefined ? initial : Math.min(override, total),
      );
    }
    return visible;
  }, [groupTotals, groupOverrides]);

  const onShowMore = (key: string): void => {
    setGroupOverrides((prior) => {
      const next = new Map(prior);
      const total = groupTotals.get(key) ?? 0;
      next.set(key, nextProgressiveCount(visibleByGroup.get(key) ?? 0, total));
      return next;
    });
  };
  const onShowAll = (key: string): void => {
    // Record the last row so focus lands on it once the button is removed.
    for (const group of filtered.findingGroups) {
      for (const subgroup of group.subgroups) {
        if (findingSubgroupKey(group.host, subgroup.service) !== key) continue;
        const last = subgroup.findings[subgroup.findings.length - 1];
        if (last !== undefined) pendingFocusRef.current = findingResultId(last.id);
      }
    }
    setGroupOverrides((prior) => {
      const next = new Map(prior);
      next.set(key, groupTotals.get(key) ?? 0);
      return next;
    });
  };

  // Page-owned coverage disclosure. A newly accepted generation resets the visible
  // bound to the initial 25; a filter/scope change clamps naturally because the
  // rendered count is min(override, filtered total) each render. Neither alters the
  // complete or filtered coverage totals.
  const coverageRows = filtered.coverageRows;
  const [coverageOverride, setCoverageOverride] = useState<number | undefined>(
    undefined,
  );
  useEffect(() => {
    setCoverageOverride(undefined);
  }, [current.refreshGeneration]);

  const coverageInitial = Math.min(
    DRIFT_UI_DEFAULTS.initialRowsPerGroup,
    coverageRows.length,
  );
  const coverageVisible = Math.min(
    coverageOverride ?? coverageInitial,
    coverageRows.length,
  );

  const onCoverageShowMore = (): void => {
    setCoverageOverride((prior) =>
      nextProgressiveCount(prior ?? coverageInitial, coverageRows.length),
    );
  };
  const onCoverageShowAll = (): void => {
    const last = coverageRows[coverageRows.length - 1];
    if (last !== undefined) pendingFocusRef.current = coverageResultId(last.host);
    setCoverageOverride(coverageRows.length);
  };

  const onClearScope = (): void => location.route("/drift", true);
  const onClearAll = (): void => {
    setFilters(emptyDriftFilters());
    location.route("/drift", true);
  };

  // Keep the keyboard refs current so the stable listener reads live values.
  searchTextRef.current = filters.text;
  scopeRef.current = scope;
  locationRef.current = location;

  const searchInput = (): HTMLElement | null =>
    containerRef.current?.querySelector<HTMLElement>('input[type="search"]') ?? null;

  // One window keydown listener over the visible finding-then-coverage results:
  // j/k/arrows, Home/End, G/gg, Enter follows the focused result's entity link,
  // `/` and Ctrl/Cmd-K focus search, and Escape clears the search, else the URL
  // scope. Keys from other controls are ignored, and Tab is never trapped.
  useListNavigation({
    getItems: () => (containerRef.current === null ? [] : resultRows(containerRef.current)),
    keys: "vim",
    getSearch: searchInput,
    onEscape: () => {
      if (searchTextRef.current !== "") {
        setFilters((prior) => ({ ...prior, text: "" }));
      } else if (scopeRef.current?.status === "scoped") {
        locationRef.current.route("/drift", true);
      } else {
        return false;
      }
      searchInput()?.focus();
      return true;
    },
    onActivate: (item) => {
      const primary = item.querySelector<HTMLElement>("[data-drift-primary]");
      if (primary === null) return;
      const href = primary.getAttribute("href");
      if (href !== null) locationRef.current.route(href);
      else primary.click();
    },
  });

  // Remember which result last held keyboard focus, so a refresh that unmounts it
  // can hand focus to the nearest surviving result.
  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;
    const onFocusIn = (event: FocusEvent): void => {
      const target = event.target as HTMLElement | null;
      lastFocusedRef.current =
        target !== null && target.matches(RESULT_SELECTOR) ? target.id : null;
    };
    container.addEventListener("focusin", onFocusIn);
    return () => container.removeEventListener("focusin", onFocusIn);
  }, []);

  // Reconcile keyboard focus after filters, generation, or progressive bounds
  // change: a surviving focused row keeps focus; a focused row that disappeared
  // (dropping focus to the document) hands it to the documented nearest visible
  // row; focus the reader moved to another control is left alone.
  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;
    const next = resultRows(container).map((row) => row.id);
    const focusedId = lastFocusedRef.current;
    if (focusedId !== null && !next.includes(focusedId)) {
      const nearest = focusIsLost()
        ? nearestSurvivor(prevVisibleRef.current, focusedId, next)
        : null;
      lastFocusedRef.current = nearest;
      if (nearest !== null) focusResultElement(container, nearest);
    }
    prevVisibleRef.current = next;
  }, [filtered, visibleByGroup, coverageVisible, current.refreshGeneration]);

  // After a show-all reveal removes the disclosure button, move focus to the last
  // newly revealed row of that group.
  useEffect(() => {
    const id = pendingFocusRef.current;
    if (id === null) return;
    pendingFocusRef.current = null;
    const container = containerRef.current;
    if (container !== null) focusResultElement(container, id);
  }, [visibleByGroup, coverageVisible]);

  const noSourceFindings = projection.summary.totalFindings === 0;
  const noFindingMatch = !noSourceFindings && filtered.filtered.findings === 0;

  return (
    <PageFrame containerRef={containerRef}>
      <VisuallyHidden as="p" aria-live="polite" aria-atomic="true">
        {updateMessage}
      </VisuallyHidden>

      {renderWarnings(state, projection)}

      <DriftOverview projection={projection} filtered={filtered} now={now} />

      <div className="flex flex-col gap-2">
        <FilterBar
          filters={filters}
          scope={scope}
          entityOptions={entityOptions}
          categories={categories}
          onFiltersChange={setFilters}
          onRemoveFilter={(facet, value) =>
            setFilters((prior) => removeCriterion(prior, facet, value))
          }
          onClearAll={onClearAll}
          onClearScope={onClearScope}
        />

        <p
          role="status"
          aria-live="polite"
          aria-atomic="true"
          className="text-sm text-muted-foreground tabular-nums"
        >
          {filteredStatusText(filtered, scope, filters)}
        </p>
      </div>

      {scope.status === "no-match" ? (
        <Callout
          tone="warn"
          role="alert"
          action={
            <Button type="button" variant="outline" size="sm" onClick={onClearScope}>
              Show all drift and coverage
            </Button>
          }
        >
          {scope.message}
        </Callout>
      ) : null}

      <Section title="Findings" headingId="drift-section-findings">
        {noSourceFindings ? (
          <EmptyState compact icon="circle-check" title="No drift reported." />
        ) : noFindingMatch ? (
          <EmptyState
            compact
            icon="search-x"
            title="No findings match the current scope and filters."
          />
        ) : model !== null ? (
          <FindingGroups
            groups={filtered.findingGroups}
            model={model}
            visibleByGroup={visibleByGroup}
            onShowMore={onShowMore}
            onShowAll={onShowAll}
          />
        ) : null}
      </Section>

      <Section title="Collection coverage" headingId="drift-section-coverage">
        {model !== null ? (
          <CoverageTable
            rows={coverageRows}
            model={model}
            now={now}
            visibleCount={coverageVisible}
            onShowMore={onCoverageShowMore}
            onShowAll={onCoverageShowAll}
          />
        ) : null}
      </Section>
    </PageFrame>
  );
}

/** Render the independent retained-generation warnings above the overview. */
function renderWarnings(
  state: DriftGenerationState,
  projection: DriftProjection,
): JSX.Element | null {
  if (!hasRetainedFailure(state, projection)) return null;
  return (
    <div className="flex flex-col gap-2">
      {state.inventory.transientError !== null ? (
        <Callout tone="warn" role="alert">
          Latest inventory request failed; showing retained data.
        </Callout>
      ) : null}
      {projection.readError !== null ? (
        <Callout tone="warn" role="alert">
          Latest snapshot read failed; showing the last successful snapshot.{" "}
          {projection.readError.message}
        </Callout>
      ) : null}
      {state.derivationError !== null ? (
        <Callout tone="warn" role="alert">
          Latest drift derivation failed; showing the previous complete
          generation.
        </Callout>
      ) : null}
    </div>
  );
}
