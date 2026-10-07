import type { HostStatus, ServiceState, ServiceStatus } from "@deck/schema";
import type { HostCollectionState, HostState } from "@deck/server";
import type { JSX } from "react";
import {
  EmptyValue,
  StatusBadge,
  defineStatusMap,
  formatAge,
  slugify,
  type StatusBadgeVariant,
  type StatusPresentation,
} from "@/ui";

/**
 * Exhaustive five-state host collection presentation. `Record<HostCollectionState,…>`
 * makes any new server state a compile failure until it gets a tone, icon and label.
 */
export const HOST_STATE_UI = defineStatusMap<HostCollectionState>({
  fresh: { tone: "ok", icon: "circle-check", label: "Fresh" },
  stale: { tone: "warn", icon: "clock-alert", label: "Stale" },
  partial: { tone: "neutral", icon: "circle-dashed", label: "Partial" },
  unreachable: { tone: "danger", icon: "cloud-off", label: "Unreachable" },
  "never-collected": { tone: "neutral", icon: "circle-slash", label: "Never collected" },
});

/** Exhaustive observed service-state presentation. */
export const SERVICE_STATE_UI = defineStatusMap<ServiceState>({
  running: { tone: "ok", icon: "circle-check", label: "Running" },
  stopped: { tone: "danger", icon: "circle-stop", label: "Stopped" },
  degraded: { tone: "warn", icon: "triangle-alert", label: "Degraded" },
  unknown: { tone: "neutral", icon: "circle-help", label: "Unknown" },
});

/** Exhaustive declared service-lifecycle presentation. */
export const SERVICE_STATUS_UI = defineStatusMap<ServiceStatus>({
  active: { tone: "ok", icon: "play", label: "Active" },
  planned: { tone: "warn", icon: "calendar-clock", label: "Planned" },
  retired: { tone: "neutral", icon: "archive", label: "Retired" },
});

/**
 * Exhaustive declared host-lifecycle presentation; mirrors `SERVICE_STATUS_UI` so a
 * retired host reads exactly like a retired service. Independent of `hidden`.
 */
export const HOST_STATUS_UI = defineStatusMap<HostStatus>({
  active: { tone: "ok", icon: "play", label: "Active" },
  planned: { tone: "warn", icon: "calendar-clock", label: "Planned" },
  retired: { tone: "neutral", icon: "archive", label: "Retired" },
});

/** Exhaustive inventory-marker presentation for non-domain-union row annotations. */
export const INVENTORY_MARKER_UI = defineStatusMap<
  "undeclared" | "hidden" | "not-declared" | "not-observed" | "no-snapshot" | "unspecified"
>({
  undeclared: { tone: "neutral", icon: "file-question", label: "Undeclared" },
  hidden: { tone: "neutral", icon: "eye-off", label: "Hidden" },
  "not-declared": { tone: "neutral", icon: "file-question", label: "Not declared" },
  "not-observed": { tone: "neutral", icon: "search-x", label: "Not observed" },
  "no-snapshot": { tone: "neutral", icon: "database-off", label: "No snapshot" },
  unspecified: { tone: "neutral", icon: "minus", label: "Unspecified" },
});

export interface InventoryMarkerProps {
  presentation: StatusPresentation;
  /** `soft` (default) for a state; `outline` for a row annotation (Undeclared, Hidden). */
  variant?: StatusBadgeVariant;
}

// The list tables render hundreds of these, so the markup is built by plain
// render functions (no extra component instance per cell); the components below
// wrap them for JSX call sites.

/**
 * One status as an aria-hidden icon plus its visible label, never colour alone.
 * `data-marker` is the label's slug (`"not-observed"`), a stable hook for tests.
 */
export function renderMarker(presentation: StatusPresentation, variant: StatusBadgeVariant = "soft"): JSX.Element {
  return (
    <StatusBadge
      tone={presentation.tone}
      icon={presentation.icon}
      label={presentation.label}
      variant={variant}
      data-marker={slugify(presentation.label)}
      className={variant === "dot" ? "text-muted-foreground" : undefined}
    />
  );
}

/** `renderMarker` as a component. */
export function InventoryMarker({ presentation, variant = "soft" }: InventoryMarkerProps): JSX.Element {
  return renderMarker(presentation, variant);
}

/**
 * An absent value (Not declared, No snapshot, Not observed, Unspecified): muted
 * text, as `@/ui`'s `NotDeclared`/`NotObserved` render it. Not a status, so no
 * badge or icon; `data-marker` keeps the same test hook as a marker.
 */
export function renderAbsent(presentation: StatusPresentation): JSX.Element {
  return <EmptyValue data-marker={slugify(presentation.label)}>{presentation.label}</EmptyValue>;
}

/** The literal `Not declared` intent field. */
export function NotDeclaredMarker(): JSX.Element {
  return renderAbsent(INVENTORY_MARKER_UI["not-declared"]);
}

/** The `No snapshot` reality value used when reality is unavailable. */
export function NoSnapshotMarker(): JSX.Element {
  return renderAbsent(INVENTORY_MARKER_UI["no-snapshot"]);
}

export interface HostStateChipProps {
  /** Derived five-state collection value and timestamp/age metadata. */
  state: HostState;
}

/**
 * Host collection coverage and its timestamp; never provider freshness.
 *
 * The server derives every field: the browser never recomputes state or age at
 * render time, so no `Date.now()` can produce a conflicting label.
 */
export function renderHostState(state: HostState): JSX.Element {
  return (
    <span data-host-state={state.state} className="inline-flex flex-col items-start gap-0.5">
      {renderMarker(HOST_STATE_UI[state.state])}
      <span className="text-xs text-muted-foreground">
        {collectionText(state)}
        {state.state === "partial" && state.pastStaleThreshold ? " · Past stale threshold" : null}
      </span>
    </span>
  );
}

/** `renderHostState` as a component. */
export function HostStateChip({ state }: HostStateChipProps): JSX.Element {
  return renderHostState(state);
}

/** Absolute `<time>`, relative age, and the null-timestamp explanations. */
function collectionText(state: HostState): JSX.Element | string | null {
  if (state.collectedAt !== null) {
    return (
      <>
        {"Collected "}
        {/* Keep the timestamp and its age whole when a narrow cell wraps the line. */}
        <time dateTime={state.collectedAt} className="whitespace-nowrap">
          {state.collectedAt}
        </time>
        {state.ageMs !== null ? (
          <span className="whitespace-nowrap">{` (${formatAge(state.ageMs)})`}</span>
        ) : null}
      </>
    );
  }
  if (state.state === "unreachable") return "No collection timestamp";
  if (state.state === "never-collected") return "No collection has been recorded";
  // Defensive: fresh/stale/partial always carry a timestamp; render nothing extra.
  return null;
}
