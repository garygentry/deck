import type { DriftSummary } from "@deck/drift";
import type { ReactNode, JSX } from "react";
import { FragmentBoundary, HealthPill, type IconName, type Tone } from "@/ui";
import { useEffect } from "react";
import type { HealthSummary } from "@/shell/health-header/health-summary.js";
import {
  getDriftGeneration,
  type AcceptedDriftGeneration,
  type DriftGenerationState,
} from "./store.js";
import { reportDriftRenderTransition } from "./diagnostics.js";
import { classifyNoGeneration, hasRetainedFailure } from "./shared.js";
import { useDriftGeneration } from "./use-drift-generation.js";

// ---------------------------------------------------------------------------
// Health-header adapter. This component satisfies the shell-owned
// `ComponentType<HealthSummary>` slot signature but deliberately ignores its
// (void) `label/status/count/freshness/href` props: it reads the same drift store
// as the page and fragments and adapts the stable feature-owned `DriftSummary`.
// It imports nothing from `alerts-and-health` and remains complete when it is the
// only summary contribution.
// ---------------------------------------------------------------------------

/** Visible health state and its decorative icon; color is supplemental only. */
type SummaryState = "ok" | "warn" | "down";

/** Exhaustive decorative-icon map for the three health states. */
const STATE_ICON: Readonly<Record<SummaryState, IconName>> = Object.freeze({
  ok: "circle-check",
  warn: "triangle-alert",
  down: "circle-x",
});

/** Library tone per health state. */
const STATE_TONE: Readonly<Record<SummaryState, Tone>> = Object.freeze({
  ok: "ok",
  warn: "warn",
  down: "danger",
});

// ---------------------------------------------------------------------------
// Presentation boundary. An adaptation/render throw is caught here and
// rendered as the fixed sanitized failure, emitting exactly one allowlisted
// summary render-error diagnostic with no exception text.
// ---------------------------------------------------------------------------

interface SummaryBoundaryProps {
  /** Summary content isolated from sibling summaries and the header shell. */
  readonly children: ReactNode;
}

/**
 * Local fixed-fallback boundary ("Drift summary unavailable", linking to
 * /drift); never exposes the caught exception, and reports the render failure.
 */
export function SummaryPresentationBoundary({ children }: SummaryBoundaryProps): JSX.Element {
  return (
    <FragmentBoundary
      label="Drift summary"
      href="/drift"
      onError={() => reportDriftRenderTransition("summary", "error", getDriftGeneration(), 0)}
    >
      {children}
    </FragmentBoundary>
  );
}

/**
 * Adapt the stable feature-owned drift summary to the existing health slot.
 *
 * The `props` are consumed only to satisfy `ComponentType<HealthSummary>`; the
 * shell renders the fragment with no props (self-sufficient), so the
 * `label/status/count/freshness/href` fields are never reinterpreted as drift data.
 */
export function DriftHealthSummary(props: HealthSummary): JSX.Element {
  void props;
  return (
    <SummaryPresentationBoundary>
      <DriftHealthSummaryContent />
    </SummaryPresentationBoundary>
  );
}

// ---------------------------------------------------------------------------
// Adapted contribution shape.
// ---------------------------------------------------------------------------

/** One adapted header contribution: health state, icon, and visible text. */
interface Contribution {
  /** Derived health state driving the icon and color. */
  readonly state: SummaryState;
  /** Visible, screen-reader-authoritative text. */
  readonly text: string;
}

/** Fixed severity labels for the highest active-risk severity. */
const SEVERITY_LABEL = Object.freeze({
  error: "Error",
  warning: "Warning",
  info: "Info",
});

/** Pluralize a waiver count without leaking any source content. */
function waiverPhrase(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * Sum of hosts needing coverage attention: unreachable, never-collected, partial,
 * and stale. `fresh` alone is complete.
 */
function incompleteCoverage(summary: DriftSummary): number {
  const { coverage } = summary;
  return (
    coverage.unreachable +
    coverage["never-collected"] +
    coverage.partial +
    coverage.stale
  );
}

/**
 * Adapt one accepted `DriftSummary` into visible detail and a base health state,
 * without changing the summary. Highest active severity is the first non-zero of
 * error/warning/info; active-waived findings never contribute to it.
 */
function adaptAvailable(summary: DriftSummary): Contribution {
  const { activeSeverity, coverage, activeWaivers, expiredWaivers, totalHosts } =
    summary;
  const incomplete = incompleteCoverage(summary);

  let severityPart: string;
  if (activeSeverity.error > 0) {
    severityPart = `${SEVERITY_LABEL.error}: ${activeSeverity.error} active`;
  } else if (activeSeverity.warning > 0) {
    severityPart = `${SEVERITY_LABEL.warning}: ${activeSeverity.warning} active`;
  } else if (activeSeverity.info > 0) {
    severityPart = `${SEVERITY_LABEL.info}: ${activeSeverity.info} active`;
  } else {
    severityPart = "No active drift";
  }

  const detail =
    `${severityPart}; ` +
    `${incomplete} of ${totalHosts} hosts need coverage attention; ` +
    `${waiverPhrase(activeWaivers, "active waiver")}; ` +
    `${waiverPhrase(expiredWaivers, "expired waiver")}.`;

  let state: SummaryState;
  if (activeSeverity.error > 0 || coverage.unreachable > 0) {
    state = "down";
  } else if (
    activeSeverity.warning > 0 ||
    activeSeverity.info > 0 ||
    incomplete > 0 ||
    activeWaivers > 0 ||
    expiredWaivers > 0
  ) {
    state = "warn";
  } else {
    state = "ok";
  }

  return { state, text: `Drift — ${detail}` };
}

/**
 * Adapt an accepted (possibly retained-with-failure) generation. A retained
 * request/read/derivation failure preserves the adapted counts, forces at least
 * `warn`, and appends the fixed retained-failure phrase.
 */
function adaptAccepted(
  state: DriftGenerationState,
  current: AcceptedDriftGeneration,
): Contribution {
  const base = adaptAvailable(current.projection.summary);
  if (!hasRetainedFailure(state, current.projection)) return base;
  const forced: SummaryState = base.state === "down" ? "down" : "warn";
  return {
    state: forced,
    text: `${base.text} Retained snapshot; refresh failed.`,
  };
}

/**
 * Derive the header contribution before an accepted projection exists. No count is
 * fabricated; each state uses a fixed phrase.
 */
function adaptNoGeneration(state: DriftGenerationState): Contribution {
  switch (classifyNoGeneration(state).kind) {
    case "derivation-failed":
      return { state: "down", text: "Drift unavailable — projection failed" };
    case "not-configured":
      return { state: "warn", text: "Drift unavailable — no snapshot configured" };
    case "read-failed":
    case "request-failed":
      return { state: "down", text: "Drift unavailable — snapshot read failed" };
    default:
      return { state: "warn", text: "Drift pending — snapshot read in progress" };
  }
}

/** Render the adapted header contribution as one ordinary `/drift` link. */
function DriftHealthSummaryContent(): JSX.Element {
  const state = useDriftGeneration();
  const current = state.current;
  const contribution =
    current !== null
      ? adaptAccepted(state, current)
      : adaptNoGeneration(state);

  // Emit exactly one successful render transition per accepted generation. The
  // module deduplicator suppresses ordinary rerenders.
  const genKey = current?.refreshGeneration ?? -1;
  useEffect(() => {
    if (current !== null) reportDriftRenderTransition("summary", "ok", state, 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [genKey]);

  return (
    <HealthPill
      href="/drift"
      tone={STATE_TONE[contribution.state]}
      icon={STATE_ICON[contribution.state]}
      label={contribution.text}
      data-drift-summary-state={contribution.state}
    />
  );
}
