/**
 * Core outcome vocabulary and the NDJSON wire-event union for governed actions.
 *
 * This module is dependency-free (imports nothing from the rest of the actions
 * subsystem) so it can be authored first and consumed by every other actions file.
 */

/**
 * The terminal outcome of an action invocation. Exactly one of these is recorded
 * for every invocation — including pre-run refusals.
 */
export type ActionOutcome =
  | "succeeded" // runner spawned and exited 0
  | "failed" // runner spawned and exited non-zero (carries exit status + output)
  | "error" // runner unreachable / not installed / failed to start (spawn threw)
  | "rejected" // refused pre-run: disabled, undeclared id, unknown runner, invalid params
  | "timed-out" // exceeded the configured max duration -> child killed
  | "cancelled"; // operator cancelled -> child killed

/** All outcomes, for exhaustive iteration in tests and audit summarization. */
export const ACTION_OUTCOMES = [
  "succeeded",
  "failed",
  "error",
  "rejected",
  "timed-out",
  "cancelled",
] as const satisfies readonly ActionOutcome[];

/** True when the outcome was decided before any runner process was spawned. */
export function isPreRunOutcome(outcome: ActionOutcome): boolean {
  return outcome === "rejected";
}

/**
 * One newline-delimited JSON event in a run's live output stream.
 *
 * Ordering invariant: exactly one `run` event first (carrying the `runId` used to
 * cancel), zero or more `stdout`/`stderr` events, then exactly one terminal `end`
 * event. `end` is always emitted, even on failure, so the UI never hangs.
 */
export type ActionRunEvent =
  | {
      /** Always the first event; carries the id needed for the cancel route. */
      type: "run";
      /** Unique run id (crypto.randomUUID()). */
      runId: string;
    }
  | {
      /** Incremental stdout chunk, UTF-8 decoded. */
      type: "stdout";
      data: string;
    }
  | {
      /** Incremental stderr chunk, UTF-8 decoded. */
      type: "stderr";
      data: string;
    }
  | {
      /** Terminal event; always last. */
      type: "end";
      /** Resolved outcome. */
      outcome: ActionOutcome;
      /** Process exit code for succeeded/failed; null otherwise. */
      exit: number | null;
      /** Wall-clock run duration in milliseconds. */
      durationMs: number;
    };

/** Discriminant literal type for `ActionRunEvent`. */
export type ActionRunEventType = ActionRunEvent["type"];

/** Serialize one event to a single NDJSON line (trailing "\n"). */
export function encodeRunEvent(event: ActionRunEvent): string {
  return `${JSON.stringify(event)}\n`;
}

/**
 * The one JSON document written to the runner's stdin, then stdin is closed.
 * Deck controls only argv[0] (the allowlisted path) and this opaque blob on a pipe;
 * it never interpolates values into a shell command.
 *
 * Kept self-contained (inline `params`/`target` shapes) so this file imports nothing
 * from validate.ts/audit.ts and stays typecheck-clean as the first file authored.
 */
export interface StructuredRunnerInput {
  /** Declared action id. */
  actionId: string;
  /** Validated parameter values keyed by param name. */
  params: Record<string, string | number | boolean>;
  /** Optional host/service target. */
  target?: { host: string; service?: string };
}
