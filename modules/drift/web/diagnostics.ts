import type { DriftGenerationState } from "./store.js";

/** Registered UI surface producing a drift render outcome. */
export type DriftSurface =
  | "page"
  | "host-fragment"
  | "service-fragment"
  | "summary";

/** Closed structured diagnostics contract; no index signature is permitted. */
export type DriftDiagnosticEvent =
  | {
      /** Derivation transition discriminator. */
      readonly event: "drift.derive";
      /** Whether complete derivation succeeded. */
      readonly outcome: "ok" | "error";
      /** Browser-local accepted inventory generation. */
      readonly refreshGeneration: number;
      /** Descriptive source time, or null when unavailable. */
      readonly snapshotGeneratedAt: string | null;
      /** Complete finding count, or zero before a successful projection. */
      readonly findingsCount: number;
      /** Complete host-state count, or zero before a successful projection. */
      readonly hostCount: number;
      /** Non-negative finite elapsed milliseconds. */
      readonly durationMs: number;
    }
  | {
      /** Surface-render transition discriminator. */
      readonly event: "drift.render";
      /** Registered surface category, not an entity identity. */
      readonly surface: DriftSurface;
      /** Whether that surface transition rendered successfully. */
      readonly outcome: "ok" | "error";
      /** Browser-local accepted drift generation. */
      readonly refreshGeneration: number;
      /** Complete finding count for that same accepted bundle. */
      readonly findingsCount: number;
      /** Complete host count for that same accepted bundle. */
      readonly hostCount: number;
      /** Non-negative finite elapsed milliseconds. */
      readonly durationMs: number;
    };

/** Injectable structured event consumer. */
export type DriftDiagnosticSink = (event: DriftDiagnosticEvent) => void;

/**
 * Normalize a measured duration to a finite, non-negative number so a broken or
 * non-monotonic clock can never publish `NaN`/`Infinity`/negative diagnostics.
 */
function normalizeDuration(value: number): number {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

/**
 * Normalize a published count to a finite, non-negative integer. Counts always
 * originate from a projection summary; this only guards against a degenerate input.
 */
function normalizeCount(value: number): number {
  return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;
}

/**
 * Reconstruct a fresh event carrying only the exact allowlisted keys for its
 * discriminator. No spread of caller data, error, envelope, projection, finding,
 * inventory, props, or component context can survive this rebuild.
 */
function canonicalizeEvent(event: DriftDiagnosticEvent): DriftDiagnosticEvent {
  if (event.event === "drift.derive") {
    return Object.freeze({
      event: "drift.derive",
      outcome: event.outcome,
      refreshGeneration: event.refreshGeneration,
      snapshotGeneratedAt:
        typeof event.snapshotGeneratedAt === "string"
          ? event.snapshotGeneratedAt
          : null,
      findingsCount: normalizeCount(event.findingsCount),
      hostCount: normalizeCount(event.hostCount),
      durationMs: normalizeDuration(event.durationMs),
    });
  }
  return Object.freeze({
    event: "drift.render",
    surface: event.surface,
    outcome: event.outcome,
    refreshGeneration: event.refreshGeneration,
    findingsCount: normalizeCount(event.findingsCount),
    hostCount: normalizeCount(event.hostCount),
    durationMs: normalizeDuration(event.durationMs),
  });
}

/**
 * The default sink passes one structured object — never an interpolated message —
 * to the console method matching its outcome. A missing console throws into the
 * emit wrapper and is discarded there.
 */
function defaultSink(event: DriftDiagnosticEvent): void {
  if (event.outcome === "ok") {
    console.info(event);
  } else {
    console.error(event);
  }
}

let activeSink: DriftDiagnosticSink = defaultSink;
let installCounter = 0;

/**
 * Replace the active sink, or restore the default when passed null.
 *
 * @param sink - Structured consumer held in memory only, or null for the default.
 * @returns An idempotent cleanup that restores the previously active sink only if
 * this installation is still current.
 */
export function setDriftDiagnosticSink(
  sink: DriftDiagnosticSink | null,
): () => void {
  const prior = activeSink;
  const myInstall = ++installCounter;
  activeSink = sink ?? defaultSink;

  let cleaned = false;
  return () => {
    if (cleaned) return;
    cleaned = true;
    // Only roll back if no later installation has replaced this one, so an older
    // component/test cleanup cannot clobber a newer sink.
    if (installCounter === myInstall) {
      activeSink = prior;
    }
  };
}

/** Emit a reconstructed, allowlisted event without exposing sink failures. */
export function emitDriftDiagnostic(event: DriftDiagnosticEvent): void {
  const canonical = canonicalizeEvent(event);
  try {
    activeSink(canonical);
  } catch {
    // A throwing or unavailable sink must not change store state, abort
    // publication, or trigger another diagnostic. Discard the caught value.
  }
}

/**
 * Latest render transition per surface, so deduplication is bounded by the four
 * `DriftSurface` values and owns no history. Overwritten on later transitions and
 * never persisted.
 */
const lastRenderTransition = new Map<
  DriftSurface,
  { readonly refreshGeneration: number; readonly outcome: "ok" | "error" }
>();

/**
 * Report one surface outcome transition through the module deduplicator.
 *
 * A transition is identified by `(surface, refreshGeneration, outcome)`; a repeat
 * of the surface's latest recorded transition emits nothing. Counts and the
 * accepted generation come only from `state.current.projection.summary`, never the
 * top-level latest inventory if it differs during failure retention.
 */
export function reportDriftRenderTransition(
  surface: DriftSurface,
  outcome: "ok" | "error",
  state: DriftGenerationState,
  durationMs: number,
): void {
  const accepted = state.current;
  const refreshGeneration =
    accepted?.refreshGeneration ?? state.inventory.refreshGeneration;
  const findingsCount = accepted?.projection.summary.totalFindings ?? 0;
  const hostCount = accepted?.projection.summary.totalHosts ?? 0;

  const prior = lastRenderTransition.get(surface);
  if (
    prior !== undefined &&
    prior.refreshGeneration === refreshGeneration &&
    prior.outcome === outcome
  ) {
    return;
  }
  lastRenderTransition.set(surface, { refreshGeneration, outcome });

  emitDriftDiagnostic({
    event: "drift.render",
    surface,
    outcome,
    refreshGeneration,
    findingsCount,
    hostCount,
    durationMs,
  });
}

/**
 * Clear the bounded render-transition deduplication map.
 *
 * @internal Tests must call this between cases so a transition recorded by an
 * earlier case cannot suppress an identical `(surface, generation, outcome)`
 * transition in a later one. Production never resets the map.
 */
export function __resetDriftRenderDedupForTest(): void {
  lastRenderTransition.clear();
}
