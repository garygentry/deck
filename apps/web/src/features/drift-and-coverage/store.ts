import { deriveDriftProjection } from "@deck/server";
import type { DriftProjection } from "@deck/server";
import type { InventoryGeneration } from "../hosts-and-services/inventory-store.js";
import {
  getInventoryGeneration,
  subscribeInventoryGeneration,
} from "../hosts-and-services/inventory-store.js";
import { emitDriftDiagnostic } from "./diagnostics.js";

/** One projection accepted from exactly one inventory generation. */
export interface AcceptedDriftGeneration {
  /** Same local id as `inventory.refreshGeneration`. */
  readonly refreshGeneration: number;
  /** Exact inventory reference used for derivation and entity resolution. */
  readonly inventory: InventoryGeneration;
  /** Projection wholly derived from that inventory envelope. */
  readonly projection: DriftProjection;
}

/** Current store snapshot, including retained derivation failure. */
export interface DriftGenerationState {
  /** Latest inventory-store reference, including current request status. */
  readonly inventory: InventoryGeneration;
  /** Last accepted matching bundle, or null when no usable generation exists. */
  readonly current: AcceptedDriftGeneration | null;
  /** Fixed safe derivation message, or null. */
  readonly derivationError: string | null;
}

/** The one fixed safe message published on any derivation failure. */
const DERIVATION_FAILED_MESSAGE = "Drift data could not be prepared.";

/** Sentinel acceptance id meaning no available generation has been attempted. */
const NO_ATTEMPT = -1;

// ---------------------------------------------------------------------------
// Module-scoped singleton state.
// The inventory store is the sole writer of network state; this store adds no
// second poller and retains at most one accepted bundle plus listener set.
// ---------------------------------------------------------------------------

let state: DriftGenerationState = Object.freeze({
  inventory: getInventoryGeneration(),
  current: null,
  derivationError: null,
});

const listeners = new Set<{ readonly listener: () => void }>();
let inventoryUnsubscribe: (() => void) | null = null;
let lastAttemptedGeneration = NO_ATTEMPT;
/** Exact inventory reference already reconciled, so duplicates are cheap no-ops. */
let lastReconciledInventory: InventoryGeneration | null = null;

/** Injectable clock factory; production uses the platform `Date`. */
let clockFactory: () => Date = () => new Date();

/** Monotonic-ish elapsed clock for derive duration; falls back to `Date.now`. */
function performanceNow(): number {
  const perf = (globalThis as { performance?: { now?: () => number } })
    .performance;
  return typeof perf?.now === "function" ? perf.now() : Date.now();
}

/** Read the one allowlisted descriptive source timestamp, or null. */
function readSnapshotGeneratedAt(inventory: InventoryGeneration): string | null {
  const snapshot = inventory.snapshot;
  if (snapshot.status !== "available") return null;
  const generatedAt = snapshot.envelope.data?.snapshot?.generatedAt;
  return typeof generatedAt === "string" ? generatedAt : null;
}

/**
 * Notify every currently-registered subscriber from a stable snapshot. One
 * listener throwing must not stop later subscribers; the caught value is
 * discarded and never logged.
 */
function notify(): void {
  for (const record of [...listeners]) {
    try {
      record.listener();
    } catch {
      // Isolate a faulty surface or unmount race from other subscribers.
    }
  }
}

/** Publish a new accepted bundle carrying the exact inventory reference used. */
function publishAccepted(
  inventory: InventoryGeneration,
  projection: DriftProjection,
): void {
  const current: AcceptedDriftGeneration = Object.freeze({
    refreshGeneration: inventory.refreshGeneration,
    inventory,
    projection,
  });
  state = Object.freeze({ inventory, current, derivationError: null });
  notify();
}

/**
 * Publish a derivation failure: retain the exact prior accepted bundle (or null
 * when none exists) and set the fixed feature message.
 */
function publishDerivationFailure(inventory: InventoryGeneration): void {
  state = Object.freeze({
    inventory,
    current: state.current,
    derivationError: DERIVATION_FAILED_MESSAGE,
  });
  notify();
}

/**
 * Publish a genuinely accepted non-available state: no usable bundle and no
 * derivation error, so old data is never presented as matching this state.
 */
function publishNonAvailable(inventory: InventoryGeneration): void {
  state = Object.freeze({ inventory, current: null, derivationError: null });
  notify();
}

/**
 * Update only the top-level inventory view for the already-attempted available
 * generation (e.g. a retained `transientError`), keeping the exact prior bundle
 * and derivation-error state. Never re-derives.
 */
function publishInventoryViewOnly(inventory: InventoryGeneration): void {
  state = Object.freeze({
    inventory,
    current: state.current,
    derivationError: state.derivationError,
  });
  notify();
}

/** Emit exactly one derive transition after outcome and duration are known. */
function emitDeriveDiagnostic(
  outcome: "ok" | "error",
  inventory: InventoryGeneration,
  projection: DriftProjection | null,
  durationMs: number,
): void {
  emitDriftDiagnostic({
    event: "drift.derive",
    outcome,
    refreshGeneration: inventory.refreshGeneration,
    snapshotGeneratedAt: readSnapshotGeneratedAt(inventory),
    findingsCount: projection?.summary.totalFindings ?? 0,
    hostCount: projection?.summary.totalHosts ?? 0,
    durationMs,
  });
}

/**
 * Reconcile one inventory notification into at most one atomic drift publication,
 * deriving exactly once per newly accepted available generation.
 */
function reconcile(nextInventory: InventoryGeneration): void {
  // A duplicate notification for an already-reconciled reference changes nothing.
  // (This is distinct from the module-init reference: the first subscriber still
  // derives an already-available initial generation whose bundle does not exist.)
  if (nextInventory === lastReconciledInventory) return;
  lastReconciledInventory = nextInventory;

  const snapshot = nextInventory.snapshot;
  if (snapshot.status !== "available") {
    publishNonAvailable(nextInventory);
    return;
  }

  const generation = nextInventory.refreshGeneration;

  // An already-attempted available generation (e.g. a retained transport-error
  // update that deliberately keeps its acceptance id) never re-derives.
  if (generation === lastAttemptedGeneration) {
    publishInventoryViewOnly(nextInventory);
    return;
  }

  // Record the attempt before deriving so a throwing derivation cannot be retried
  // by unrelated subscribers or duplicate notifications.
  lastAttemptedGeneration = generation;

  const startedAt = performanceNow();
  let projection: DriftProjection;
  try {
    projection = deriveDriftProjection(snapshot.envelope, clockFactory());
  } catch {
    const durationMs = performanceNow() - startedAt;
    // Never inspect or include the caught value in state, UI text, or diagnostics.
    publishDerivationFailure(nextInventory);
    emitDeriveDiagnostic("error", nextInventory, null, durationMs);
    return;
  }
  const durationMs = performanceNow() - startedAt;
  publishAccepted(nextInventory, projection);
  emitDeriveDiagnostic("ok", nextInventory, projection, durationMs);
}

/** React to any inventory-store publication. */
function onInventoryChange(): void {
  reconcile(getInventoryGeneration());
}

/** Return the current frozen drift-store reference. */
export function getDriftGeneration(): DriftGenerationState {
  return state;
}

/**
 * Subscribe to whole-reference drift-store changes. The first subscriber
 * establishes exactly one inventory subscription and reconciles current inventory
 * immediately; the last unsubscribe releases it while retaining drift state.
 *
 * @param listener - Synchronous invalidation callback; consumers re-read with
 * `getDriftGeneration()`.
 * @returns An idempotent unsubscribe function.
 */
export function subscribeDriftGeneration(listener: () => void): () => void {
  const record = { listener };
  const wasEmpty = listeners.size === 0;
  listeners.add(record);

  if (wasEmpty) {
    inventoryUnsubscribe = subscribeInventoryGeneration(onInventoryChange);
    // Inventory registration does not synchronously notify; reconcile once so an
    // already-accepted generation derives immediately for this first subscriber.
    reconcile(getInventoryGeneration());
  }

  let active = true;
  return () => {
    if (!active) return;
    active = false;
    listeners.delete(record);
    if (listeners.size === 0 && inventoryUnsubscribe !== null) {
      inventoryUnsubscribe();
      inventoryUnsubscribe = null;
    }
  };
}

/**
 * Install a test-only clock factory for deterministic derive timing/waivers.
 *
 * @param factory - Clock provider, or null to restore the platform `Date`.
 * @internal Tests must reset this after each case; production keeps `Date`.
 */
export function __setDriftClockForTest(factory: (() => Date) | null): void {
  clockFactory = factory ?? (() => new Date());
}
