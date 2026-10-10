import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";

import { SNAPSHOT_READ_MESSAGES, SnapshotReadFailure } from "./errors.js";

/** Default hard cap. No operator-facing override is introduced. */
export const MAX_SNAPSHOT_BYTES = 50 * 1024 * 1024;

/** Bounded streaming chunk size; one chunk bounds any oversize over-read. */
const CHUNK_BYTES = 64 * 1024;

/** Exact torn-write refusal message required by REQ-CONC-02. */
const TORN_FILE_MESSAGE = "Snapshot file changed while being read.";

/** Opaque candidate identity accepted only after parse and validation succeed. */
export interface SnapshotRevision {
  /** Concrete adapter class that issued the candidate. */
  readonly sourceKind: "path" | "url";
  /** Unforgeable candidate identity accepted only by its issuing adapter. */
  readonly token: symbol;
}

/** A source read either confirms the accepted revision or returns bounded text. */
export type SnapshotSourceResult =
  | {
      /** Discriminator for a source whose accepted revision has not changed. */
      changed: false;
      /** Number of bytes accounted for by this read; zero is valid for HTTP 304. */
      bytes: number;
    }
  | {
      /** Discriminator for a bounded candidate requiring parse, validation, and acceptance. */
      changed: true;
      /** Number of source bytes consumed for this candidate. */
      bytes: number;
      /** UTF-8 snapshot text available only for a changed candidate. */
      text: string;
      /** Opaque source-owned candidate identity committed only after successful validation. */
      revision: SnapshotRevision;
    };

/** Immutable single-source adapter used by `SnapshotProvider`. */
export interface SnapshotSource {
  /** Sanitized source class; never the configured source value. */
  readonly kind: "path" | "url";
  /** Perform one bounded, abort-aware changed/unchanged read. */
  read(signal: AbortSignal): Promise<SnapshotSourceResult>;
  /** Commit a candidate validator; valid only for a token issued by this source. */
  accept(revision: SnapshotRevision): void;
}

export interface SnapshotSourceOptions {
  /** Maximum bytes consumed before refusal. */
  maxBytes?: number;
  /** Fetch injection for HTTP tests; defaults to `globalThis.fetch`. */
  fetch?: typeof globalThis.fetch;
}

/** Change-detection validator for one accepted file revision. */
interface FileValidator {
  readonly mtimeMs: number;
  readonly size: number;
}

function fail(
  code: import("./errors.js").SnapshotReadErrorCode,
  details?: import("./errors.js").SnapshotReadFailureDetails,
  message?: string,
): SnapshotReadFailure {
  return new SnapshotReadFailure(code, message ?? SNAPSHOT_READ_MESSAGES[code], details);
}

/**
 * Stream a file in bounded 64 KiB chunks, enforcing the cumulative size cap and
 * the abort signal. Rejects with a typed `SnapshotReadFailure`:
 * `POLL_TIMEOUT` for abort, `DOCUMENT_TOO_LARGE` once cumulative bytes exceed the
 * cap (no later than `maxBytes + 64 KiB`), and `SOURCE_UNREADABLE` for any other
 * stream error. The full source is never retained beyond the collected buffer.
 */
function readStreamBounded(
  absolutePath: string,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Buffer> {
  return new Promise<Buffer>((resolvePromise, rejectPromise) => {
    const stream = createReadStream(absolutePath, { highWaterMark: CHUNK_BYTES });
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    const onAbort = (): void => {
      stream.destroy();
      finish(fail("POLL_TIMEOUT"));
    };
    const finish = (error: SnapshotReadFailure | null, value?: Buffer): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      if (error) rejectPromise(error);
      else resolvePromise(value as Buffer);
    };

    if (signal.aborted) {
      stream.destroy();
      finish(fail("POLL_TIMEOUT"));
      return;
    }
    signal.addEventListener("abort", onAbort);

    stream.on("data", (chunk: string | Buffer) => {
      // No stream encoding is set, so chunks are always Buffers.
      const buffer = chunk as Buffer;
      // Account for attempted bytes before appending so a refusal reports the
      // exact cumulative count, including the chunk that crossed the cap.
      total += buffer.byteLength;
      if (total > maxBytes) {
        stream.destroy();
        finish(fail("DOCUMENT_TOO_LARGE", { attemptedBytes: total }));
        return;
      }
      chunks.push(buffer);
    });
    stream.on("error", () => {
      finish(fail("SOURCE_UNREADABLE"));
    });
    stream.on("end", () => {
      finish(null, Buffer.concat(chunks));
    });
  });
}

/**
 * Bounded file adapter. Its immutable absolute path is captured privately and
 * never exposed through properties, errors, or logs. The accepted validator is
 * the `(mtimeMs,size)` pair, committed only through `accept(revision)`.
 */
function createFileSource(absolutePath: string, maxBytes: number): SnapshotSource {
  let acceptedPair: FileValidator | null = null;
  let acceptedToken: symbol | null = null;
  let pendingPair: FileValidator | null = null;
  let pendingToken: symbol | null = null;

  const statFile = async (): Promise<FileValidator> => {
    let stats: Awaited<ReturnType<typeof stat>>;
    try {
      stats = await stat(absolutePath);
    } catch {
      // Missing, permission, and every other filesystem failure is sanitized;
      // the absolute path and original exception text are never propagated.
      throw fail("SOURCE_UNREADABLE");
    }
    if (!stats.isFile()) throw fail("SOURCE_UNREADABLE");
    return { mtimeMs: stats.mtimeMs, size: stats.size };
  };

  return {
    kind: "path",
    async read(signal: AbortSignal): Promise<SnapshotSourceResult> {
      // 1. Refuse an aborted signal before touching the filesystem.
      if (signal.aborted) throw fail("POLL_TIMEOUT");

      // 2. Stat first; map every filesystem failure to SOURCE_UNREADABLE.
      const pre = await statFile();

      // 3. Unchanged accepted revision skips open/read entirely.
      if (acceptedPair && acceptedPair.mtimeMs === pre.mtimeMs && acceptedPair.size === pre.size) {
        return { changed: false, bytes: pre.size };
      }

      // 4. Reject a declared oversize before opening a stream.
      if (pre.size > maxBytes) {
        throw fail("DOCUMENT_TOO_LARGE", { attemptedBytes: pre.size });
      }

      // 5-6. Stream with cumulative size enforcement and abort handling.
      const buffer = await readStreamBounded(absolutePath, maxBytes, signal);

      // 7. Re-stat after EOF; a changed tuple is a torn write.
      const post = await statFile();
      if (post.mtimeMs !== pre.mtimeMs || post.size !== pre.size) {
        throw fail("SOURCE_UNREADABLE", undefined, TORN_FILE_MESSAGE);
      }

      // 8. Issue a new opaque revision for the stable tuple. Acceptance is
      // deferred: reading alone never commits the validator, so an invalid
      // document is retried on the next poll even with an unchanged tuple.
      const token = Symbol("snapshot-file-revision");
      pendingToken = token;
      pendingPair = { mtimeMs: pre.mtimeMs, size: pre.size };
      return {
        changed: true,
        bytes: buffer.byteLength,
        text: buffer.toString("utf8"),
        revision: { sourceKind: "path", token },
      };
    },
    accept(revision: SnapshotRevision): void {
      // A foreign adapter's token can never be accepted here.
      if (revision.sourceKind !== "path") throw fail("INTERNAL");
      // Re-accepting the already-committed latest revision is a no-op.
      if (acceptedToken !== null && revision.token === acceptedToken) return;
      // Only the latest pending token commits its candidate pair.
      if (pendingToken !== null && revision.token === pendingToken) {
        acceptedToken = pendingToken;
        acceptedPair = pendingPair;
        pendingToken = null;
        pendingPair = null;
        return;
      }
      // A superseded or otherwise unknown token is impossible in normal flow.
      throw fail("INTERNAL");
    },
  };
}

/** Conditional-request validators carried by one accepted HTTP response. */
interface HttpValidator {
  readonly etag: string | null;
  readonly lastModified: string | null;
}

/** True for aborted-signal and `TimeoutError`-shaped rejections mapped to timeout. */
function isAbortLike(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true;
  if (typeof error === "object" && error !== null) {
    const name = (error as { name?: unknown }).name;
    return name === "AbortError" || name === "TimeoutError";
  }
  return false;
}

/**
 * Parse `Content-Length` as an unsigned decimal integer. A missing or malformed
 * value returns null and is not trusted; the reader falls through to streaming.
 */
function parseContentLength(value: string | null): number | null {
  if (value === null || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Consume an HTTP body in bounded chunks, enforcing the cumulative size cap and
 * the abort signal. Rejects with a typed `SnapshotReadFailure`: `POLL_TIMEOUT`
 * for abort during consumption, `DOCUMENT_TOO_LARGE` once cumulative bytes exceed
 * the cap (cancelling by no later than `maxBytes` plus one network chunk), and
 * `SOURCE_UNREADABLE` for any other stream error. Upstream text is never
 * propagated and the reader lock is always released.
 */
async function readHttpBodyBounded(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Buffer> {
  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (error) {
        throw isAbortLike(error, signal) ? fail("POLL_TIMEOUT") : fail("SOURCE_UNREADABLE");
      }
      if (chunk.done) break;
      // Account for attempted bytes before appending so a refusal reports the
      // exact cumulative count, including the chunk that crossed the cap.
      total += chunk.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw fail("DOCUMENT_TOO_LARGE", { attemptedBytes: total });
      }
      chunks.push(Buffer.from(chunk.value));
    }
    return Buffer.concat(chunks);
  } finally {
    reader.releaseLock();
  }
}

/**
 * Bounded HTTP(S) adapter. Its immutable cloned URL and last-accepted `ETag`/
 * `Last-Modified` validators are captured privately and never exposed through
 * properties, errors, or logs. One `read` performs exactly one GET carrying the
 * supplied abort signal and only conditional headers derived from accepted
 * validators; no credentials, cookies, body, or mutating method are added.
 */
function createUrlSource(
  url: URL,
  maxBytes: number,
  fetchImpl: typeof globalThis.fetch | undefined,
): SnapshotSource {
  // Wrap so an unbound global fetch is always invoked with a valid receiver.
  const doFetch: typeof globalThis.fetch =
    fetchImpl ?? ((input, init) => globalThis.fetch(input, init));

  let acceptedValidator: HttpValidator | null = null;
  let acceptedToken: symbol | null = null;
  let pendingValidator: HttpValidator | null = null;
  let pendingToken: symbol | null = null;

  return {
    kind: "url",
    async read(signal: AbortSignal): Promise<SnapshotSourceResult> {
      // 1. Refuse an aborted signal before issuing a request.
      if (signal.aborted) throw fail("POLL_TIMEOUT");

      // Conditional headers come only from the last accepted response.
      const headers: Record<string, string> = {};
      if (acceptedValidator?.etag != null) headers["If-None-Match"] = acceptedValidator.etag;
      if (acceptedValidator?.lastModified != null) {
        headers["If-Modified-Since"] = acceptedValidator.lastModified;
      }

      // 2. One GET with the registry signal; no credentials, cookies, or body.
      let response: Response;
      try {
        response = await doFetch(url, { method: "GET", signal, headers });
      } catch (error) {
        // Abort maps to timeout; every other transport failure is sanitized.
        throw isAbortLike(error, signal) ? fail("POLL_TIMEOUT") : fail("SOURCE_UNREADABLE");
      }

      // 3. A 304 confirms the accepted revision without reading or accepting.
      if (response.status === 304) {
        return { changed: false, bytes: 0 };
      }

      // 4. Any non-2xx status refuses, carrying only the numeric status.
      if (response.status < 200 || response.status > 299) {
        throw fail(
          "HTTP_STATUS",
          { httpStatus: response.status, attemptedBytes: 0 },
          SNAPSHOT_READ_MESSAGES.HTTP_STATUS.replace("<status>", String(response.status)),
        );
      }

      // 5. Pre-reject a trustworthy declared oversize before consuming the body.
      const declared = parseContentLength(response.headers.get("content-length"));
      if (declared !== null && declared > maxBytes) {
        try {
          await response.body?.cancel();
        } catch {
          // The refusal is already decided; a cancel failure changes nothing.
        }
        throw fail("DOCUMENT_TOO_LARGE", { attemptedBytes: declared });
      }

      // 6. A changed success requires a readable body.
      if (response.body === null) throw fail("SOURCE_UNREADABLE");

      // 7. Stream with cumulative size enforcement and abort handling.
      const buffer = await readHttpBodyBounded(response.body, maxBytes, signal);

      // 8. Issue a new opaque revision holding only this response's validators.
      // Acceptance is deferred: reading alone never commits the validators, so an
      // invalid body is retried and cannot poison future conditional headers.
      const token = Symbol("snapshot-url-revision");
      pendingToken = token;
      pendingValidator = {
        etag: response.headers.get("etag"),
        lastModified: response.headers.get("last-modified"),
      };
      return {
        changed: true,
        bytes: buffer.byteLength,
        text: buffer.toString("utf8"),
        revision: { sourceKind: "url", token },
      };
    },
    accept(revision: SnapshotRevision): void {
      // A foreign adapter's token can never be accepted here.
      if (revision.sourceKind !== "url") throw fail("INTERNAL");
      // Re-accepting the already-committed latest revision is a no-op.
      if (acceptedToken !== null && revision.token === acceptedToken) return;
      // Only the latest pending token commits its candidate validators.
      if (pendingToken !== null && revision.token === pendingToken) {
        acceptedToken = pendingToken;
        acceptedValidator = pendingValidator;
        pendingToken = null;
        pendingValidator = null;
        return;
      }
      // A superseded or otherwise unknown token is impossible in normal flow.
      throw fail("INTERNAL");
    },
  };
}

/**
 * Resolve one runtime value into one immutable bounded source.
 *
 * @param configured - Non-empty value read once from `DECK_SNAPSHOT_SOURCE` at boot.
 * @param options - Test injection and size-cap override.
 * @returns A path or URL adapter whose location cannot change after construction.
 * @throws {SnapshotReadFailure} `SOURCE_UNREADABLE` for an empty/whitespace-only value.
 * @throws {SnapshotReadFailure} `SOURCE_PROTOCOL_UNSUPPORTED` for non-HTTP URI schemes.
 * @throws {SnapshotReadFailure} `INTERNAL` for an invalid `maxBytes` override.
 */
export function createSnapshotSource(
  configured: string,
  options: SnapshotSourceOptions = {},
): SnapshotSource {
  const maxBytes = options.maxBytes ?? MAX_SNAPSHOT_BYTES;
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) throw fail("INTERNAL");

  // Absence is handled by boot/registration; an empty value here is unreadable.
  if (configured.trim() === "") throw fail("SOURCE_UNREADABLE");

  const schemeMatch = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(configured);
  if (schemeMatch) {
    const scheme = schemeMatch[1].toLowerCase();
    if (scheme !== "http" && scheme !== "https") {
      throw fail(
        "SOURCE_PROTOCOL_UNSUPPORTED",
        undefined,
        SNAPSHOT_READ_MESSAGES.SOURCE_PROTOCOL_UNSUPPORTED.replace("<protocol>", scheme),
      );
    }
    let url: URL;
    try {
      url = new URL(configured);
    } catch {
      // URL parser diagnostics may include the configured source. Preserve the
      // typed boundary without retaining that input or the native exception.
      throw fail("SOURCE_UNREADABLE");
    }
    // Clone so later mutation of the input URL cannot retarget the source.
    return createUrlSource(new URL(url.href), maxBytes, options.fetch);
  }

  // Resolve a relative path exactly once; later working-directory changes cannot
  // retarget it. The absolute path is captured privately by the adapter.
  return createFileSource(resolve(configured), maxBytes);
}
