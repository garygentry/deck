import type { SnapshotReadError } from "@deck/contract";

export const SNAPSHOT_READ_ERROR_CODES = [
  "SOURCE_PROTOCOL_UNSUPPORTED",
  "SOURCE_UNREADABLE",
  "HTTP_STATUS",
  "DOCUMENT_TOO_LARGE",
  "POLL_TIMEOUT",
  "JSON_INVALID",
  "VERSION_UNSUPPORTED",
  "SNAPSHOT_INVALID",
  "STALE_THRESHOLD_INVALID",
  "INTERNAL",
] as const;

export type SnapshotReadErrorCode = (typeof SNAPSHOT_READ_ERROR_CODES)[number];

/** Canonical safe default message for each snapshot refusal class. */
export const SNAPSHOT_READ_MESSAGES: Readonly<Record<SnapshotReadErrorCode, string>> = {
  SOURCE_PROTOCOL_UNSUPPORTED:
    "Snapshot source protocol <protocol> is not supported; use a file path or HTTP(S) URL.",
  SOURCE_UNREADABLE:
    "Snapshot source is unavailable; verify that the configured path or URL is readable.",
  HTTP_STATUS: "Snapshot source returned HTTP <status>; verify the remote snapshot endpoint.",
  DOCUMENT_TOO_LARGE: "Snapshot document exceeds the 50 MiB limit; reduce the snapshot size.",
  POLL_TIMEOUT: "Snapshot read timed out; verify source availability and try again.",
  JSON_INVALID: "Snapshot document is not valid JSON; regenerate the snapshot.",
  VERSION_UNSUPPORTED:
    "Snapshot schema version is unsupported; regenerate it with a supported schema version.",
  SNAPSHOT_INVALID:
    "Snapshot validation could not complete; regenerate the snapshot and inspect server logs.",
  STALE_THRESHOLD_INVALID:
    "Snapshot staleAfter is invalid; configure a finite positive ISO-8601 duration.",
  INTERNAL: "Snapshot read failed unexpectedly; inspect server logs and try again.",
};

/** Server-internal refusal metadata; only `httpStatus` is public. */
export interface SnapshotReadFailureDetails {
  /** HTTP status for an HTTP_STATUS refusal. */
  readonly httpStatus?: number;
  /** Bytes consumed or declared before refusal, when known; never serialized publicly. */
  readonly attemptedBytes?: number;
}

/** Internal typed refusal. Convert to `SnapshotReadError` before publication. */
export class SnapshotReadFailure extends Error {
  readonly name = "SnapshotReadFailure";

  constructor(
    readonly code: SnapshotReadErrorCode,
    message: string,
    readonly details: SnapshotReadFailureDetails = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
  }

  /** Produce the source-safe wire representation without internal byte accounting. */
  toPublic(): SnapshotReadError {
    return {
      code: this.code,
      message: this.message,
      ...(this.details.httpStatus === undefined ? {} : { httpStatus: this.details.httpStatus }),
    };
  }
}

/** True for aborted-signal and `TimeoutError`-shaped errors mapped to `POLL_TIMEOUT`. */
function isAbortShaped(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const name = (error as { name?: unknown }).name;
  return name === "AbortError" || name === "TimeoutError";
}

/**
 * Normalize aborts and unknown failures without exposing upstream text.
 *
 * Preserves an existing `SnapshotReadFailure` (including its internal
 * `details.attemptedBytes`); maps abort-shaped errors and `TimeoutError` to
 * `POLL_TIMEOUT`; maps everything else to a sanitized `INTERNAL`.
 */
export function normalizeSnapshotFailure(error: unknown): SnapshotReadFailure {
  if (error instanceof SnapshotReadFailure) return error;
  if (isAbortShaped(error)) {
    return new SnapshotReadFailure("POLL_TIMEOUT", SNAPSHOT_READ_MESSAGES.POLL_TIMEOUT);
  }
  return new SnapshotReadFailure("INTERNAL", SNAPSHOT_READ_MESSAGES.INTERNAL);
}
