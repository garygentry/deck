/**
 * Typed error class for governed action runs.
 *
 * Mirrors the closed message-table + `.toPublic()` discipline of
 * `modules/snapshot/server/errors.ts`: a closed-union `code`, a safe
 * canonical message table, non-public `details`, and a `.toPublic()` that strips
 * internals before the wire/audit.
 */

import type { ActionOutcome } from "./events.js";
import type { ParamError } from "./validate.js";

/** Closed set of failure codes, aligned to the non-success outcomes. */
export const ACTION_RUN_ERROR_CODES = [
  "REJECTED", // pre-run refusal (disabled / undeclared / unknown runner / invalid params)
  "SPAWN_ERROR", // runner unreachable / not installed / failed to start -> outcome "error"
  "TIMED_OUT", // exceeded timeoutMs -> outcome "timed-out"
  "CANCELLED", // operator cancel -> outcome "cancelled"
  "INTERNAL", // unexpected; sanitized
] as const;

/** Failure codes a run can terminate with. */
export type ActionRunFailureCode = (typeof ACTION_RUN_ERROR_CODES)[number];

/** Canonical safe default message per failure code (no upstream text leaked). */
export const ACTION_RUN_MESSAGES: Readonly<Record<ActionRunFailureCode, string>> = {
  REJECTED: "The action was refused before running.",
  SPAWN_ERROR: "The runner could not be started; verify it is installed and reachable.",
  TIMED_OUT: "The run exceeded the configured maximum duration and was terminated.",
  CANCELLED: "The run was cancelled by an operator.",
  INTERNAL: "The action failed unexpectedly; inspect server logs and try again.",
};

/** The outcome each failure code maps to when recorded in the audit log. */
export const ACTION_RUN_CODE_TO_OUTCOME: Readonly<
  Record<ActionRunFailureCode, ActionOutcome>
> = {
  REJECTED: "rejected",
  SPAWN_ERROR: "error",
  TIMED_OUT: "timed-out",
  CANCELLED: "cancelled",
  INTERNAL: "error",
};

/** Server-internal refusal metadata; never serialized publicly. */
export interface ActionRunFailureDetails {
  /** HTTP status for a pre-run refusal, when known. */
  readonly httpStatus?: number;
  /** Per-parameter errors for a validation refusal. */
  readonly paramErrors?: readonly ParamError[];
  /** Public code string surfaced via apiError, when the failure is pre-run. */
  readonly publicCode?: string;
}

/** The public wire shape of an action failure. */
export interface ActionRunError {
  code: ActionRunFailureCode;
  message: string;
  outcome: ActionOutcome;
  httpStatus?: number;
  paramErrors?: readonly ParamError[];
}

/** Internal typed refusal; convert to `ActionRunError` before publication. */
export class ActionRunFailure extends Error {
  readonly name = "ActionRunFailure";

  constructor(
    readonly code: ActionRunFailureCode,
    message: string,
    readonly details: ActionRunFailureDetails = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
  }

  /** The outcome this failure records in the audit log. */
  get outcome(): ActionOutcome {
    return ACTION_RUN_CODE_TO_OUTCOME[this.code];
  }

  /** Source-safe wire representation, no internal metadata beyond httpStatus/paramErrors. */
  toPublic(): ActionRunError {
    return {
      code: this.code,
      message: this.message,
      outcome: this.outcome,
      ...(this.details.httpStatus === undefined
        ? {}
        : { httpStatus: this.details.httpStatus }),
      ...(this.details.paramErrors === undefined
        ? {}
        : { paramErrors: this.details.paramErrors }),
    };
  }
}

/** True for aborted-signal and `TimeoutError`-shaped errors. */
function isAbortShaped(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const name = (error as { name?: unknown }).name;
  return name === "AbortError" || name === "TimeoutError";
}

/**
 * True when an abort carries an explicit operator-cancel reason (rather than a
 * timeout). The executor aborts a cancel with a `cancelReason` marker, threaded
 * either directly on the error or on its `cause`.
 */
function abortCarriesCancelReason(error: unknown): boolean {
  const carriers: unknown[] = [error];
  if (typeof error === "object" && error !== null) {
    carriers.push((error as { cause?: unknown }).cause);
  }
  for (const carrier of carriers) {
    if (typeof carrier !== "object" || carrier === null) continue;
    const reason = (carrier as { cancelReason?: unknown; reason?: unknown });
    if (reason.cancelReason === "cancelled" || reason.reason === "cancelled") {
      return true;
    }
  }
  return false;
}

/** True for Node spawn-shaped errors (ENOENT/EACCES, or a `spawn …` syscall). */
function isSpawnShaped(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const e = error as { code?: unknown; syscall?: unknown };
  if (e.code === "ENOENT" || e.code === "EACCES") return true;
  if (typeof e.syscall === "string" && e.syscall.startsWith("spawn")) return true;
  return false;
}

/**
 * Normalize abort/timeout/spawn-shaped throwables and unknowns into an
 * `ActionRunFailure`, exactly as `normalizeSnapshotFailure` does for the read side.
 *
 * - An existing `ActionRunFailure` is preserved.
 * - Abort/timeout shapes map to `TIMED_OUT` — or `CANCELLED` when the abort carries
 *   an explicit operator-cancel reason.
 * - Spawn/ENOENT/EACCES shapes map to `SPAWN_ERROR`.
 * - Everything else maps to a sanitized `INTERNAL`.
 */
export function normalizeActionFailure(error: unknown): ActionRunFailure {
  if (error instanceof ActionRunFailure) return error;
  if (isAbortShaped(error)) {
    const code: ActionRunFailureCode = abortCarriesCancelReason(error)
      ? "CANCELLED"
      : "TIMED_OUT";
    return new ActionRunFailure(code, ACTION_RUN_MESSAGES[code]);
  }
  if (isSpawnShaped(error)) {
    return new ActionRunFailure("SPAWN_ERROR", ACTION_RUN_MESSAGES.SPAWN_ERROR);
  }
  return new ActionRunFailure("INTERNAL", ACTION_RUN_MESSAGES.INTERNAL);
}
