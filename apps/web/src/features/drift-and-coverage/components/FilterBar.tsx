import { driftServiceFacetKey } from "@deck/server";
import type {
  DriftFilters,
  DriftSeverity,
  HostCollectionState,
  WaiverState,
} from "@deck/server";
import type { JSX } from "react";
import {
  ActiveFilters,
  Button,
  FacetFilter,
  FilterBar as FilterBarFrame,
  Icon,
  SearchInput,
  type ActiveFilter,
  type FacetOption,
} from "@/ui";
import { DRIFT_COVERAGE, DRIFT_SEVERITY, DRIFT_WAIVER } from "../constants.js";
import type { DriftEntityScope, DriftScopeResult } from "../scope.js";

/** One exact host/service option used by local entity facet controls. */
export interface DriftEntityFilterOption {
  /** Collision-safe component-local token; never shown to the user or put in the URL. */
  readonly token: string;
  /** Exact entity identity represented by the option. */
  readonly scope: DriftEntityScope;
  /** Visible label containing both host and service when service is present. */
  readonly label: string;
}

/** Controlled local filters and the URL-backed scope chip. */
export interface FilterBarProps {
  /** Current local filter criteria; URL scope is composed separately by the page. */
  readonly filters: DriftFilters;
  /** Parsed URL scope, including explained no-match states. */
  readonly scope: DriftScopeResult;
  /** Complete-generation host/service options, in deterministic projection order. */
  readonly entityOptions: readonly DriftEntityFilterOption[];
  /** Complete-generation open category options in exact code-point order. */
  readonly categories: readonly string[];
  /** Replace local filter state without changing URL scope. */
  readonly onFiltersChange: (filters: DriftFilters) => void;
  /** Remove one local criterion while preserving every other criterion. */
  readonly onRemoveFilter: (facet: keyof DriftFilters, value?: string) => void;
  /** Clear all local criteria and URL scope, using replacement navigation. */
  readonly onClearAll: () => void;
  /** Remove only URL-backed scope, using replacement navigation. */
  readonly onClearScope: () => void;
}

/** Fixed finding-severity option order. */
const SEVERITY_OPTIONS: readonly DriftSeverity[] = ["error", "warning", "info"];
/** Fixed display-time waiver option order. */
const WAIVER_OPTIONS: readonly WaiverState[] = ["unwaived", "active", "expired"];
/** Fixed authoritative coverage-state option order. */
const COVERAGE_STATE_OPTIONS: readonly HostCollectionState[] = [
  "fresh",
  "stale",
  "partial",
  "unreachable",
  "never-collected",
];

/** An empty `DriftFilters` value used to clear only local criteria. */
export function emptyDriftFilters(): DriftFilters {
  return {
    text: "",
    severities: new Set<DriftSeverity>(),
    hosts: new Set<string>(),
    services: new Set<string>(),
    categories: new Set<string>(),
    waiverStates: new Set<WaiverState>(),
    coverageHosts: new Set<string>(),
    coverageStates: new Set<HostCollectionState>(),
  };
}

/** True when any local criterion differs from its empty default. */
export function hasLocalCriteria(filters: DriftFilters): boolean {
  return (
    filters.text !== "" ||
    filters.severities.size > 0 ||
    filters.hosts.size > 0 ||
    filters.services.size > 0 ||
    filters.categories.size > 0 ||
    filters.waiverStates.size > 0 ||
    filters.coverageHosts.size > 0 ||
    filters.coverageStates.size > 0
  );
}

/** Visible chip label for a `driftServiceFacetKey` service value. */
function serviceLabelFromKey(key: string): string {
  try {
    const parsed = JSON.parse(key) as unknown;
    if (Array.isArray(parsed) && parsed.length === 2) {
      return `${String(parsed[1])} on ${String(parsed[0])}`;
    }
  } catch {
    // A non-JSON key is impossible for values produced by driftServiceFacetKey;
    // fall back to the raw key rather than throwing on hostile input.
  }
  return key;
}

/** Visible label for the URL scope chip. */
function scopeChipLabel(scope: DriftEntityScope): string {
  return scope.service !== undefined
    ? `Service ${scope.service} on ${scope.host}`
    : `Host ${scope.host}`;
}

/** Build the ordered active-criteria chips from the current local filters. */
function buildChips(filters: DriftFilters): ActiveFilter<keyof DriftFilters>[] {
  const chips: ActiveFilter<keyof DriftFilters>[] = [];
  const push = (
    facet: keyof DriftFilters,
    facetLabel: string,
    value: string,
    label: string,
  ): void => {
    chips.push({ id: `${facet}:${value}`, facet, facetLabel, value, label });
  };
  if (filters.text !== "") push("text", "search", filters.text, filters.text);
  for (const severity of filters.severities) {
    push("severities", "severity", severity, DRIFT_SEVERITY[severity].label);
  }
  for (const host of filters.hosts) push("hosts", "host", host, host);
  for (const service of filters.services) {
    push("services", "service", service, serviceLabelFromKey(service));
  }
  for (const category of filters.categories) {
    push("categories", "category", category, category);
  }
  for (const waiver of filters.waiverStates) {
    push("waiverStates", "waiver status", waiver, DRIFT_WAIVER[waiver].label);
  }
  for (const host of filters.coverageHosts) {
    push("coverageHosts", "coverage host", host, host);
  }
  for (const state of filters.coverageStates) {
    push("coverageStates", "coverage state", state, DRIFT_COVERAGE[state].label);
  }
  return chips;
}

/** The entity facet's value for an option: the host, or the service facet key. */
function entityValue(option: DriftEntityFilterOption): string {
  return option.scope.service === undefined
    ? `host:${option.scope.host}`
    : `service:${serviceKey(option)}`;
}

/** The `services` filter key of a service option. */
function serviceKey(option: DriftEntityFilterOption): string {
  return driftServiceFacetKey({ host: option.scope.host, service: option.scope.service! });
}

/**
 * Render the read-only filter controls: a labelled search field, the finding
 * facets (severity, host/service, category, waiver), the coverage facets (host
 * and state), removable active chips and explicit clear actions. Finding and
 * coverage criteria are independent; clearing local criteria never changes URL
 * scope, and clear-scope/clear-all use replacement navigation owned by the page.
 */
export function FilterBar({
  filters,
  scope,
  entityOptions,
  categories,
  onFiltersChange,
  onRemoveFilter,
  onClearAll,
  onClearScope,
}: FilterBarProps): JSX.Element {
  const hostOptions = entityOptions.filter(
    (option) => option.scope.service === undefined,
  );
  const chips = buildChips(filters);
  const localActive = hasLocalCriteria(filters);
  const scopeActive = scope.status !== "unscoped";

  // The host/service facet mixes host values and service keys in one selection.
  // Values are namespaced so a host name can never collide with a service key.
  const entitySelected = new Set<string>([
    ...[...filters.hosts].map((host) => `host:${host}`),
    ...[...filters.services].map((key) => `service:${key}`),
  ]);
  const onEntityChange = (next: Set<string>): void => {
    const hosts = new Set<string>();
    const services = new Set<string>();
    for (const option of entityOptions) {
      if (!next.has(entityValue(option))) continue;
      if (option.scope.service === undefined) hosts.add(option.scope.host);
      else services.add(serviceKey(option));
    }
    onFiltersChange({ ...filters, hosts, services });
  };

  const facets: {
    readonly title: string;
    readonly options: FacetOption[];
    readonly selected: ReadonlySet<string>;
    readonly onChange: (next: Set<string>) => void;
  }[] = [
    {
      title: "Severity",
      options: SEVERITY_OPTIONS.map((value) => ({
        value,
        label: DRIFT_SEVERITY[value].label,
        icon: DRIFT_SEVERITY[value].icon,
      })),
      selected: filters.severities,
      onChange: (next) =>
        onFiltersChange({ ...filters, severities: next as Set<DriftSeverity> }),
    },
    {
      title: "Host/service",
      options: entityOptions.map((option) => ({
        value: entityValue(option),
        label: option.label,
      })),
      selected: entitySelected,
      onChange: onEntityChange,
    },
    {
      title: "Category",
      options: categories.map((value) => ({ value, label: value })),
      selected: filters.categories,
      onChange: (next) => onFiltersChange({ ...filters, categories: next }),
    },
    {
      title: "Waiver status",
      options: WAIVER_OPTIONS.map((value) => ({
        value,
        label: DRIFT_WAIVER[value].label,
        icon: DRIFT_WAIVER[value].icon,
      })),
      selected: filters.waiverStates,
      onChange: (next) =>
        onFiltersChange({ ...filters, waiverStates: next as Set<WaiverState> }),
    },
    {
      title: "Coverage host",
      options: hostOptions.map((option) => ({
        value: option.scope.host,
        label: option.scope.host,
      })),
      selected: filters.coverageHosts,
      onChange: (next) => onFiltersChange({ ...filters, coverageHosts: next }),
    },
    {
      title: "Coverage state",
      options: COVERAGE_STATE_OPTIONS.map((value) => ({
        value,
        label: DRIFT_COVERAGE[value].label,
        icon: DRIFT_COVERAGE[value].icon,
      })),
      selected: filters.coverageStates,
      onChange: (next) =>
        onFiltersChange({
          ...filters,
          coverageStates: next as Set<HostCollectionState>,
        }),
    },
  ];

  return (
    <FilterBarFrame
      label="Drift filters"
      search={
        <SearchInput
          label="Search drift findings"
          placeholder="Search findings…"
          value={filters.text}
          onValueChange={(text) => onFiltersChange({ ...filters, text })}
        />
      }
      activeFilters={
        chips.length > 0 || scopeActive ? (
          <div className="flex flex-wrap items-center gap-1.5">
            {scope.status === "scoped" ? (
              <button
                type="button"
                aria-label={`Remove entity scope ${scopeChipLabel(scope.scope)}`}
                onClick={onClearScope}
                className="inline-flex h-6 max-w-64 items-center gap-1 rounded-full border border-primary/40 bg-primary/10 py-0.5 pr-1.5 pl-2.5 text-xs font-medium text-foreground outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                <span className="text-muted-foreground">scope:</span>
                <span className="truncate">{scopeChipLabel(scope.scope)}</span>
                <Icon name="x" size={12} />
              </button>
            ) : null}
            <ActiveFilters
              filters={chips}
              onRemove={(chip) =>
                onRemoveFilter(
                  chip.facet!,
                  chip.facet === "text" ? undefined : chip.value,
                )
              }
              onClearAll={() => onFiltersChange(emptyDriftFilters())}
              clearAllLabel="Clear local filters"
            />
            {localActive || scopeActive ? (
              <Button type="button" variant="ghost" size="xs" onClick={onClearAll}>
                Clear all filters and scope
              </Button>
            ) : null}
          </div>
        ) : undefined
      }
    >
      {facets.map((facet) => (
        <FacetFilter
          key={facet.title}
          variant="popover"
          title={facet.title}
          options={facet.options}
          selected={facet.selected}
          onSelectedChange={facet.onChange}
        />
      ))}
    </FilterBarFrame>
  );
}
