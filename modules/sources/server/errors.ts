/**
 * Typed error hierarchy for the sources capability.
 *
 * Mirrors `SnapshotReadFailure` (`providers/snapshot/errors.ts`) and `ActionRunFailure`
 * (`modules/actions/server/errors.ts`): a closed-union `code`, a safe canonical message table, non-public
 * `details`, and a `.toPublic()` that strips internals before the wire/log. **No credential
 * value or attempted absolute path is ever carried publicly** (REQ-SEC-03, REQ-OBS-02,
 * REQ-SEC-02).
 */

/** Closed set of source failure codes, spanning acquisition, confinement, and read. */
export const SOURCE_ERROR_CODES = [
  "SOURCE_NOT_FOUND", // unknown / typed-off source id — route → 404
  "PATH_NOT_CONFINED", // traversal/absolute/symlink-escape — route → 400 (REQ-SEC-02)
  "PATH_NOT_FOUND", // confined but no such file — route → 404
  "SOURCE_UNAVAILABLE", // git missing / clone|fetch failed / local root unreadable (REQ-FRESH-02/03)
  "ACQUIRE_TIMEOUT", // acquisition exceeded the provider timeout
  "READ_TOO_LARGE", // internal guard when a raw read would exceed the byte cap
  "INTERNAL", // unexpected; sanitized
] as const;

export type SourceFailureCode = (typeof SOURCE_ERROR_CODES)[number];

/** Canonical safe default message per code (no upstream text, path, or credential leaked). */
export const SOURCE_MESSAGES: Readonly<Record<SourceFailureCode, string>> = {
  SOURCE_NOT_FOUND: "The requested source is not available.",
  PATH_NOT_CONFINED: "The requested path is outside the source root.",
  PATH_NOT_FOUND: "The requested file does not exist in this source.",
  SOURCE_UNAVAILABLE:
    "The source could not be acquired; serving the last known content if available.",
  ACQUIRE_TIMEOUT: "Acquiring the source timed out.",
  READ_TOO_LARGE: "The requested file exceeds the readable size limit.",
  INTERNAL: "The source request failed unexpectedly.",
};

/** HTTP status paired with each code that a route surfaces directly. */
export const SOURCE_HTTP_STATUS: Readonly<Record<SourceFailureCode, 400 | 404 | 500>> = {
  SOURCE_NOT_FOUND: 404,
  PATH_NOT_CONFINED: 400,
  PATH_NOT_FOUND: 404,
  SOURCE_UNAVAILABLE: 500,
  ACQUIRE_TIMEOUT: 500,
  READ_TOO_LARGE: 400,
  INTERNAL: 500,
};

/** Server-internal failure metadata; NEVER serialized publicly. */
export interface SourceFailureDetails {
  /** The offending relative path, kept for server logs only — never echoed to the client. */
  readonly attemptedPath?: string;
  /** The source id in play (safe to log; carries no secret). */
  readonly sourceId?: string;
  /** Acquisition failure kind for logs (e.g. "clone", "fetch", "walk") — REQ-OBS-02. */
  readonly failureKind?: string;
}

/** The public wire shape of a source failure (the typed `ApiError` body). */
export interface SourceApiError {
  error: string;
  code: SourceFailureCode;
}

/** Internal typed failure; convert to `SourceApiError` before publication. */
export class SourceFailure extends Error {
  readonly name = "SourceFailure";

  constructor(
    readonly code: SourceFailureCode,
    message: string = SOURCE_MESSAGES[code],
    readonly details: SourceFailureDetails = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
  }

  /** HTTP status this failure maps to (§ table above). */
  get httpStatus(): number {
    return SOURCE_HTTP_STATUS[this.code];
  }

  /** Source-safe wire body — code + canonical message, no path/credential/internal detail. */
  toPublic(): SourceApiError {
    return { error: SOURCE_MESSAGES[this.code], code: this.code };
  }
}

/** True for aborted-signal and `TimeoutError`-shaped errors mapped to `ACQUIRE_TIMEOUT`. */
function isAbortShaped(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const name = (error as { name?: unknown }).name;
  return name === "AbortError" || name === "TimeoutError";
}

/** True for spawn-shaped errors (a `git` binary that is absent / cannot be started). */
function isSpawnShaped(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const e = error as { code?: unknown; syscall?: unknown };
  if (typeof e.syscall === "string" && e.syscall.startsWith("spawn")) return true;
  return false;
}

/** True for filesystem "no such file" errors (a confined but missing file). */
function isFileNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  return (error as { code?: unknown }).code === "ENOENT";
}

/**
 * True for a git operation that ran but exited non-zero (clone/fetch failure). The
 * acquisition layer (item 005) marks such an error with `code === "GIT_NONZERO_EXIT"`
 * or a non-zero numeric `exitCode`/`status`.
 */
function isGitNonZeroExit(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const e = error as { code?: unknown; exitCode?: unknown; status?: unknown };
  if (e.code === "GIT_NONZERO_EXIT") return true;
  if (typeof e.exitCode === "number" && e.exitCode !== 0) return true;
  if (typeof e.status === "number" && e.status !== 0) return true;
  return false;
}

/**
 * Normalize spawn/abort/fs throwables and unknowns into a `SourceFailure`.
 *
 * - An existing `SourceFailure` is preserved as-is.
 * - Abort/timeout shapes → `ACQUIRE_TIMEOUT`.
 * - Spawn failure (git absent) / git non-zero exit → `SOURCE_UNAVAILABLE`.
 * - Filesystem ENOENT (a confined but missing file) → `PATH_NOT_FOUND`.
 * - Everything else → a sanitized `INTERNAL`.
 *
 * The confinement choke point (03) throws `PATH_NOT_CONFINED` directly, not via this
 * normalizer. Provided `details` are threaded onto the produced failure for server logs.
 */
export function normalizeSourceFailure(
  error: unknown,
  details?: SourceFailureDetails,
): SourceFailure {
  if (error instanceof SourceFailure) return error;

  const code: SourceFailureCode = isAbortShaped(error)
    ? "ACQUIRE_TIMEOUT"
    : isSpawnShaped(error) || isGitNonZeroExit(error)
      ? "SOURCE_UNAVAILABLE"
      : isFileNotFound(error)
        ? "PATH_NOT_FOUND"
        : "INTERNAL";

  return new SourceFailure(code, SOURCE_MESSAGES[code], details ?? {}, { cause: error });
}
