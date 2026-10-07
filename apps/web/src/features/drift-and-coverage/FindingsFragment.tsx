import { DRIFT_UI_DEFAULTS } from "@deck/server";
import type {
  CoverageRow,
  DriftFindingProjection,
  HostCollectionState,
} from "@deck/server";
import type { ReactNode, JSX } from "react";
import { useEffect, useRef, useState } from "react";
import {
  Button,
  Callout,
  EmptyState,
  ErrorState,
  FragmentBoundary,
  List,
  ListItem,
  StatusBadge,
  VisuallyHidden,
} from "@/ui";
import type { InventoryModel } from "../hosts-and-services/model.js";
import type { EntityRef } from "../../registry/registry.js";
import {
  DRIFT_SEVERITY,
  DRIFT_WAIVER,
  nextProgressiveCount,
} from "./constants.js";
import { EntityLink, UnresolvedLocation } from "./components/FindingRow.js";
import {
  reportDriftRenderTransition,
  type DriftSurface,
} from "./diagnostics.js";
import { driftScopeHref } from "./scope.js";
import type { DriftEntityScope } from "./scope.js";
import {
  classifyNoGeneration,
  hasRetainedFailure,
  resolveFindingLocation,
} from "./shared.js";
import { getDriftGeneration } from "./store.js";
import type { AcceptedDriftGeneration, DriftGenerationState } from "./store.js";
import { useDriftGeneration } from "./use-drift-generation.js";

/** Host or service entity supplied by the registry findings slot. */
export interface FindingsFragmentProps {
  /** Exact frozen shell entity reference to scope findings against. */
  readonly entity: EntityRef;
}

// ---------------------------------------------------------------------------
// Presentation boundary. A selection/render throw inside one fragment is caught
// here and rendered as the fixed sanitized failure, emitting exactly one
// allowlisted render-error diagnostic with no exception text. The outer boundary
// in `EntitySlots.tsx` remains the final isolation.
// ---------------------------------------------------------------------------

/** Local fixed-fallback boundary; never renders the caught exception. */
export function FragmentPresentationBoundary({
  surface,
  children,
}: {
  /** Registered surface category reported on an isolated render failure. */
  readonly surface: DriftSurface;
  /** Fragment content isolated from the detail core and sibling slots. */
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <FragmentBoundary
      label="Drift findings"
      onError={() => reportDriftRenderTransition(surface, "error", getDriftGeneration(), 0)}
      fallback={
        <section data-slot="drift-findings" aria-label="Drift findings">
          <ErrorState compact title="Drift findings could not be displayed." />
        </section>
      }
    >
      {children}
    </FragmentBoundary>
  );
}

/**
 * Render drift findings scoped to one inventory detail-page entity.
 *
 * Host scope includes the host-level subgroup and every service subgroup; service
 * scope requires a non-empty name and includes only the exact `(host, service)`
 * subgroup. The fragment reads one accepted generation through `useDriftGeneration`
 * and never fetches, derives, or maintains a second copy of projection state.
 */
export function FindingsFragment({ entity }: FindingsFragmentProps): JSX.Element {
  const surface: DriftSurface =
    entity.entity === "host" ? "host-fragment" : "service-fragment";
  return (
    <FragmentPresentationBoundary surface={surface}>
      <FindingsFragmentContent entity={entity} surface={surface} />
    </FragmentPresentationBoundary>
  );
}

// ---------------------------------------------------------------------------
// Selection.
// ---------------------------------------------------------------------------

/**
 * Select findings for the entity over `findingGroups` without resorting, in exact
 * projection order. Host scope flattens the one matching host group's subgroups
 * in published order; a service scope returns only its exact subgroup. A service
 * identity is never inferred from a message/path and is never matched without
 * the host. (A service entity with no name never reaches selection.)
 */
function selectFindings(
  groups: AcceptedDriftGeneration["projection"]["findingGroups"],
  entity: EntityRef,
): readonly DriftFindingProjection[] {
  const group = groups.find((candidate) => candidate.host === entity.host);
  if (group === undefined) return [];
  if (entity.entity === "service") {
    const subgroup = group.subgroups.find(
      (candidate) => candidate.service === entity.name,
    );
    return subgroup?.findings ?? [];
  }
  return group.subgroups.flatMap((subgroup) => subgroup.findings);
}

/** Compact selected-population counts computed without mutating `DriftSummary`. */
interface CompactCounts {
  /** Total selected findings regardless of waiver. */
  readonly total: number;
  /** Active-risk error count (unwaived or expired). */
  readonly error: number;
  /** Active-risk warning count. */
  readonly warning: number;
  /** Active-risk info count. */
  readonly info: number;
  /** Findings whose waiver is active at derivation time. */
  readonly activeWaivers: number;
  /** Findings whose waiver is expired or malformed. */
  readonly expiredWaivers: number;
}

/**
 * Compute compact counts over the selected findings. An active waiver suppresses
 * active risk; an expired waiver still counts as active risk and is also disclosed
 * as an expired waiver. These are local display values only.
 */
function computeCounts(
  findings: readonly DriftFindingProjection[],
): CompactCounts {
  let error = 0;
  let warning = 0;
  let info = 0;
  let activeWaivers = 0;
  let expiredWaivers = 0;
  for (const finding of findings) {
    if (finding.waiverState === "active") {
      activeWaivers += 1;
      continue;
    }
    if (finding.waiverState === "expired") expiredWaivers += 1;
    if (finding.severity === "error") error += 1;
    else if (finding.severity === "warning") warning += 1;
    else info += 1;
  }
  return { total: findings.length, error, warning, info, activeWaivers, expiredWaivers };
}

// ---------------------------------------------------------------------------
// Qualified empty-state messages.
// ---------------------------------------------------------------------------

/** Exact qualified empty-population message for each authoritative host state. */
const COVERAGE_EMPTY_MESSAGE: Readonly<Record<HostCollectionState, string>> =
  Object.freeze({
    fresh:
      "No drift reported for this entity in the current snapshot. Host collection is fresh.",
    stale: "No drift reported for this entity; host collection is stale.",
    partial: "No drift reported for this entity; host collection is partial.",
    unreachable:
      "No drift reported for this entity; the host is unreachable.",
    "never-collected":
      "No drift reported for this entity; the host has never been collected.",
  });

/** Message used when the accepted projection has no coverage row for the host. */
const COVERAGE_UNAVAILABLE_MESSAGE =
  "No drift reported for this entity; collection coverage is unavailable.";

/**
 * Qualify a zero selected population using the host's authoritative coverage
 * state, which a service inherits from its host. A missing coverage row is stated
 * explicitly rather than presented as an all-clear.
 */
function qualifiedEmptyMessage(
  rows: readonly CoverageRow[],
  host: string,
): string {
  const row = rows.find((candidate) => candidate.host === host);
  return row === undefined
    ? COVERAGE_UNAVAILABLE_MESSAGE
    : COVERAGE_EMPTY_MESSAGE[row.state];
}

// ---------------------------------------------------------------------------
// No-accepted-generation states.
// ---------------------------------------------------------------------------

/** Render the explicit no-config / pending / failed-first-read status. */
function renderNoGeneration(state: DriftGenerationState): JSX.Element {
  const reason = classifyNoGeneration(state);
  switch (reason.kind) {
    case "derivation-failed":
      return (
        <ErrorState
          compact
          title="Drift could not be derived; no drift result is available."
          message={reason.detail}
        />
      );
    case "not-configured":
      return (
        <EmptyState
          compact
          icon="database-off"
          title="No snapshot is configured; drift has not been checked."
        />
      );
    case "read-failed":
    case "request-failed":
      return (
        <ErrorState
          compact
          title="Snapshot read failed; no drift result is available."
          message={reason.detail ?? undefined}
        />
      );
    default:
      return (
        <Callout tone="pending" icon="hourglass" compact>
          Snapshot read pending; drift has not been checked.
        </Callout>
      );
  }
}

// ---------------------------------------------------------------------------
// Compact row + list rendering.
// ---------------------------------------------------------------------------

/** Collision-safe, stable result id for one fragment finding row. */
function fragmentRowId(id: string): string {
  return `drift-fragment-finding-${encodeURIComponent(id)}`;
}

/**
 * Render one compact finding row: severity, waiver state, inert message, context,
 * and a resolved detail link or explicit unresolved text. Evidence is intentionally
 * omitted; the scoped `/drift` link reaches the full presentation.
 */
function CompactRow({
  finding,
  model,
  isService,
}: {
  readonly finding: DriftFindingProjection;
  readonly model: InventoryModel;
  readonly isService: boolean;
}): JSX.Element {
  const location = resolveFindingLocation(finding, model);
  const context = isService
    ? finding.category
    : finding.service === null
      ? `Host-level · ${finding.category}`
      : `${finding.service} · ${finding.category}`;

  return (
    <ListItem
      id={fragmentRowId(finding.id)}
      tabIndex={-1}
      title={<span className="break-words">{finding.message}</span>}
      description={context}
    >
      <div className="mt-1 flex flex-col gap-1.5">
        <p className="flex flex-wrap items-center gap-2">
          {StatusBadge.fromMap(DRIFT_SEVERITY, finding.severity)}
          {StatusBadge.fromMap(DRIFT_WAIVER, finding.waiverState, { variant: "dot" })}
        </p>
        {location.href !== null ? (
          <EntityLink href={location.href}>{location.linkLabel!}</EntityLink>
        ) : (
          <UnresolvedLocation />
        )}
      </div>
    </ListItem>
  );
}

/** Compose the compact selected-population count line. */
function countLine(counts: CompactCounts): string {
  const noun = counts.total === 1 ? "finding" : "findings";
  return (
    `${counts.total} scoped ${noun}. ` +
    `Active risk: ${counts.error} error, ${counts.warning} warning, ${counts.info} info. ` +
    `Active waivers: ${counts.activeWaivers}. Expired waivers: ${counts.expiredWaivers}.`
  );
}

/** True when `node` is the same as, or a descendant of, `container`. */
function containsNode(container: ParentNode | null, node: Node | null): boolean {
  if (container === null || node === null) return false;
  let current: Node | null = node;
  while (current !== null) {
    if (current === (container as unknown as Node)) return true;
    current = (current as { parentNode: Node | null }).parentNode;
  }
  return false;
}

/** Read the active element without assuming a DOM is present. */
function activeElement(): Element | null {
  if (typeof document === "undefined") return null;
  return document.activeElement;
}

/**
 * Render one accepted generation scoped to the entity: the compact counts, the
 * scoped `/drift` link, inert bounded rows with progressive disclosure, or the
 * coverage-qualified empty state. The root is a `data-slot` subtree, so it renders
 * on the component library even inside a page that still uses legacy styles.
 */
function FindingsFragmentContent({
  entity,
  surface,
}: {
  readonly entity: EntityRef;
  readonly surface: DriftSurface;
}): JSX.Element {
  const state = useDriftGeneration();
  const current = state.current;

  const headingId = `drift-fragment-${surface}`;
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const containerRef = useRef<HTMLElement | null>(null);
  // Whether focus was inside this fragment at the last committed render. Read in
  // the render body so it reflects the DOM before the next commit.
  const hadFocusRef = useRef(false);

  // Bounded progressive disclosure. A changing entity/generation token resets the
  // visible bound synchronously during render, so a new scope always starts at the
  // initial bound without an extra commit.
  const token = `${entity.entity}|${entity.host}|${entity.name ?? ""}|${
    current?.refreshGeneration ?? -1
  }`;
  const tokenRef = useRef(token);
  const [override, setOverride] = useState<number | null>(null);
  const [liveMessage, setLiveMessage] = useState("");
  if (tokenRef.current !== token) {
    tokenRef.current = token;
    setOverride(null);
    setLiveMessage("");
  }

  // Emit exactly one successful render transition per accepted generation. The
  // module deduplicator suppresses ordinary rerenders and disclosure clicks.
  const genKey = current?.refreshGeneration ?? -1;
  useEffect(() => {
    if (current !== null) reportDriftRenderTransition(surface, "ok", state, 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [genKey, surface]);

  // Capture whether focus rests inside this fragment before the next commit.
  hadFocusRef.current = containsNode(
    containerRef.current,
    activeElement() as unknown as Node | null,
  );

  // Reconcile focus to the heading only when a previously focused row no longer
  // exists after an entity/generation change; a normal refresh never steals focus.
  useEffect(() => {
    if (!hadFocusRef.current) return;
    const container = containerRef.current;
    if (container === null) return;
    if (!containsNode(container, activeElement() as unknown as Node | null)) {
      headingRef.current?.focus();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const headingText =
    entity.entity === "service"
      ? `Drift findings for service ${entity.name ?? ""} on ${entity.host}`
      : `Drift findings for host ${entity.host}`;

  return (
    <section
      ref={containerRef}
      data-slot="drift-findings"
      aria-labelledby={headingId}
      className="flex min-w-0 flex-col gap-3 text-sm"
    >
      <h3
        id={headingId}
        ref={headingRef}
        tabIndex={-1}
        className="text-base font-semibold outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        {headingText}
      </h3>
      <VisuallyHidden as="p" aria-live="polite" aria-atomic="true">
        {liveMessage}
      </VisuallyHidden>
      {renderBody({
        entity,
        surface,
        state,
        current,
        override,
        setOverride,
        setLiveMessage,
      })}
    </section>
  );
}

/** Shared arguments for the fragment body branches. */
interface BodyArgs {
  readonly entity: EntityRef;
  readonly surface: DriftSurface;
  readonly state: DriftGenerationState;
  readonly current: AcceptedDriftGeneration | null;
  readonly override: number | null;
  readonly setOverride: (next: number | null) => void;
  readonly setLiveMessage: (next: string) => void;
}

/** Choose the single body surface for the fragment's current state. */
function renderBody(args: BodyArgs): JSX.Element {
  const { entity, state, current } = args;

  // A malformed service entity is stated without broadening to host scope.
  if (entity.entity === "service" && (entity.name === undefined || entity.name === "")) {
    return <ErrorState compact title="Unable to scope findings for this service." />;
  }

  if (current === null) return renderNoGeneration(state);

  return <AvailableBody {...args} current={current} />;
}

/** Render the selected population, or its coverage-qualified empty state. */
function AvailableBody({
  entity,
  surface,
  state,
  current,
  override,
  setOverride,
  setLiveMessage,
}: BodyArgs & { readonly current: AcceptedDriftGeneration }): JSX.Element {
  const projection = current.projection;
  const model = current.inventory.model;
  const findings = selectFindings(projection.findingGroups, entity);
  const isService = entity.entity === "service";

  // Build the scoped link eagerly so the failure-diagnostic hook is unconditional.
  const scope: DriftEntityScope = isService
    ? { host: entity.host, service: entity.name! }
    : { host: entity.host };
  let scopedHref: string | null = null;
  try {
    scopedHref = driftScopeHref(scope);
  } catch {
    scopedHref = null;
  }
  const willRenderLink = model !== null && findings.length > 0;
  const hrefFailed = scopedHref === null;
  useHrefFailureDiagnostic(willRenderLink && hrefFailed, surface, state);

  const warning = hasRetainedFailure(state, projection) ? (
    <Callout tone="warn" role="alert" compact>
      The latest snapshot refresh failed; showing a retained drift generation that
      may be aging.
    </Callout>
  ) : null;

  if (model === null) {
    // Defensive: an accepted generation always carries a model. Nothing to link.
    return <>{warning}</>;
  }

  if (findings.length === 0) {
    return (
      <>
        {warning}
        <EmptyState
          compact
          icon="circle-check"
          title={qualifiedEmptyMessage(projection.coverageRows, entity.host)}
        />
      </>
    );
  }

  const counts = computeCounts(findings);
  const total = findings.length;
  const visible = Math.min(override ?? DRIFT_UI_DEFAULTS.initialRowsPerGroup, total);
  const remaining = total - visible;
  const more = Math.min(DRIFT_UI_DEFAULTS.additionalRowsPerStep, remaining);

  const onShowMore = (): void => {
    const next = nextProgressiveCount(visible, total);
    setOverride(next);
    setLiveMessage(`Showing ${Math.min(next, total)} of ${total} findings.`);
  };
  const onShowAll = (): void => {
    setOverride(total);
    setLiveMessage(`Showing all ${total} findings.`);
  };

  return (
    <>
      {warning}
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p role="status" className="text-muted-foreground tabular-nums">
          {countLine(counts)}
        </p>
        {hrefFailed ? (
          <p role="alert" className="text-status-danger-fg">
            Scoped Drift link unavailable
          </p>
        ) : (
          <EntityLink href={scopedHref!}>View these findings in the Drift view</EntityLink>
        )}
      </div>
      <List as="ol" variant="divided">
        {findings.slice(0, visible).map((finding) => (
          <CompactRow
            key={finding.id}
            finding={finding}
            model={model}
            isService={isService}
          />
        ))}
      </List>
      {remaining > 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-label={`Show ${more} more scoped findings`}
            onClick={onShowMore}
          >
            Show {more} more
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={onShowAll}>
            Show all {total} findings
          </Button>
        </div>
      ) : null}
    </>
  );
}

/** Emit one allowlisted render-error diagnostic when scoped href construction fails. */
function useHrefFailureDiagnostic(
  failed: boolean,
  surface: DriftSurface,
  state: DriftGenerationState,
): void {
  useEffect(() => {
    if (failed) reportDriftRenderTransition(surface, "error", state, 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [failed, surface]);
}
