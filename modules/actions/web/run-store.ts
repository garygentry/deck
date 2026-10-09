/**
 * Module-singleton run state for governed actions.
 *
 * Mirrors `modules/drift/web/store.ts`: a module-scoped `Object.freeze`d
 * state value replaced atomically, a `Set` of listener records, an isolating
 * `notify()` that iterates a copy and swallows a throwing listener, a
 * `getRunState()` snapshot reader, and a `subscribeRunState(listener) => () => void`
 * returning an idempotent unsubscribe.
 *
 * This module holds NO HTTP logic (that lives in `client.ts`); the client calls
 * the exported mutators, which are the only writers.
 */

import type { ParamError } from "@deck/contract/actions";
import type { ActionOutcome, ActionRunEvent } from "../server/types.js";

/** Metadata for a pre-run refusal surfaced after an invoke. */
export interface RunRefusal {
  /**
   * Stable public code from ACTION_REFUSAL_CODES: ACTIONS_DISABLED,
   * ACTION_UNKNOWN, RUNNER_UNRESOLVED, PARAMS_INVALID, or "REQUEST" for a
   * transport failure the client itself classified.
   */
  readonly code: string;
  /** Safe, human-readable message for the terminal panel. */
  readonly message: string;
  /** Per-parameter errors when code === "PARAMS_INVALID". */
  readonly paramErrors?: readonly ParamError[];
}

/**
 * The one in-flight / last-run state. A discriminated union so a surface branches
 * exhaustively and never renders a fabricated outcome. Every non-idle state carries
 * the `actionId` that produced it.
 */
export type RunState =
  | { readonly status: "idle" }
  | { readonly status: "requesting"; readonly actionId: string }
  | {
      readonly status: "streaming";
      readonly actionId: string;
      /** Run id from the first `run` event; the key the Cancel control passes to cancelRun. */
      readonly runId: string;
      /** Accumulated stdout text, appended per `stdout` event. */
      readonly stdout: string;
      /** Accumulated stderr text, appended per `stderr` event. */
      readonly stderr: string;
    }
  | {
      readonly status: "terminal";
      readonly actionId: string;
      /** Present once a run started; null for a pre-run refusal (no run id was issued). */
      readonly runId: string | null;
      /** Resolved outcome; drives the distinct terminal panel. */
      readonly outcome: ActionOutcome;
      /** Exit code for succeeded/failed; null otherwise. */
      readonly exit: number | null;
      /** Wall-clock duration from the `end` event; 0 for a pre-run refusal. */
      readonly durationMs: number;
      readonly stdout: string;
      readonly stderr: string;
      /** Present only when outcome === "rejected" (or a client-classified refusal). */
      readonly refusal?: RunRefusal;
    };

/** The initial and reset state. */
export const IDLE_RUN_STATE: RunState = Object.freeze({ status: "idle" });

// ---------------------------------------------------------------------------
// Module-scoped singleton state.
// A single frozen object replaced atomically; the client (client.ts) is the only
// writer, through the exported mutators.
// ---------------------------------------------------------------------------

let state: RunState = IDLE_RUN_STATE;

const listeners = new Set<{ readonly listener: () => void }>();

/**
 * Notify every currently-registered subscriber from a stable snapshot. One listener
 * throwing must not stop later subscribers; the caught value is discarded.
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

/** Read the current frozen run-state reference. */
export function getRunState(): RunState {
  return state;
}

/**
 * Subscribe to whole-reference run-state changes (drift store pattern). The listener
 * is a synchronous invalidation callback; consumers re-read with `getRunState()`.
 *
 * @returns An idempotent unsubscribe function.
 */
export function subscribeRunState(listener: () => void): () => void {
  const record = { listener };
  listeners.add(record);

  let active = true;
  return () => {
    if (!active) return;
    active = false;
    listeners.delete(record);
  };
}

// ---------------------------------------------------------------------------
// Mutators (called only by client.ts).
// ---------------------------------------------------------------------------

/** idle/terminal → requesting for a new invocation. Ignores re-entry while streaming. */
export function beginRun(actionId: string): void {
  if (state.status === "requesting" || state.status === "streaming") {
    // A run is already in flight; do not clobber it. Defensive — the caller gates.
    return;
  }
  state = Object.freeze({ status: "requesting", actionId });
  notify();
}

/**
 * Apply one wire event to the current state:
 *  - `run`    : requesting → streaming (records runId; resets stdout/stderr to "")
 *  - `stdout` : append data to stdout (streaming only; ignored otherwise)
 *  - `stderr` : append data to stderr (streaming only; ignored otherwise)
 *  - `end`    : streaming → terminal (outcome/exit/durationMs, keeps captured text)
 * Unknown/out-of-order events are ignored defensively; the store never throws.
 */
export function applyRunEvent(event: ActionRunEvent): void {
  switch (event.type) {
    case "run": {
      // Only a requesting run may transition to streaming. Reset captured text.
      if (state.status !== "requesting") return;
      state = Object.freeze({
        status: "streaming",
        actionId: state.actionId,
        runId: event.runId,
        stdout: "",
        stderr: "",
      });
      notify();
      return;
    }
    case "stdout": {
      if (state.status !== "streaming") return;
      state = Object.freeze({
        ...state,
        stdout: state.stdout + event.data,
      });
      notify();
      return;
    }
    case "stderr": {
      if (state.status !== "streaming") return;
      state = Object.freeze({
        ...state,
        stderr: state.stderr + event.data,
      });
      notify();
      return;
    }
    case "end": {
      if (state.status !== "streaming") return;
      state = Object.freeze({
        status: "terminal",
        actionId: state.actionId,
        runId: state.runId,
        outcome: event.outcome,
        exit: event.exit,
        durationMs: event.durationMs,
        stdout: state.stdout,
        stderr: state.stderr,
      });
      notify();
      return;
    }
    default:
      // Unknown event type: ignore defensively, never throw.
      return;
  }
}

/** requesting/streaming → terminal for a pre-run refusal or client-side stream failure. */
export function failRun(refusal: RunRefusal, outcome: ActionOutcome = "rejected"): void {
  // A refusal can arrive from requesting (pre-run) or streaming (mid-stream error).
  // Retain any captured text and the runId when streaming; null the runId for a
  // pre-run refusal (no run id was issued).
  if (state.status === "streaming") {
    state = Object.freeze({
      status: "terminal",
      actionId: state.actionId,
      runId: state.runId,
      outcome,
      exit: null,
      durationMs: 0,
      stdout: state.stdout,
      stderr: state.stderr,
      refusal,
    });
    notify();
    return;
  }
  if (state.status === "requesting") {
    state = Object.freeze({
      status: "terminal",
      actionId: state.actionId,
      runId: null,
      outcome,
      exit: null,
      durationMs: 0,
      stdout: "",
      stderr: "",
      refusal,
    });
    notify();
    return;
  }
  // idle/terminal: nothing in flight to fail. Ignore defensively.
}

/** Any state → idle. Called when the operator dismisses a finished run. */
export function resetRun(): void {
  if (state.status === "idle") return;
  state = IDLE_RUN_STATE;
  notify();
}
