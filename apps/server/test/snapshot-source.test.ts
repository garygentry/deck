import { chmodSync, createReadStream, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import * as nodePath from "node:path";
import { join } from "node:path";
import { Readable } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

// `node:fs/promises`.stat is a non-configurable export, so it cannot be spied
// with `vi.spyOn`. Replace the module with a call-through vi.fn that defaults to
// the real implementation; individual tests queue `mockResolvedValueOnce` values
// to simulate a growing file or a torn pre/post-stat mismatch.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, createReadStream: vi.fn(actual.createReadStream) };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, stat: vi.fn(actual.stat) };
});

// Wrap `resolve` in a call-through vi.fn so a test can prove a relative path is
// resolved exactly once, at construction, rather than on every read.
vi.mock("node:path", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:path")>();
  return { ...actual, resolve: vi.fn(actual.resolve) };
});

import {
  SNAPSHOT_READ_MESSAGES,
  SnapshotReadFailure,
} from "../src/providers/snapshot/errors.js";
import {
  MAX_SNAPSHOT_BYTES,
  createSnapshotSource,
  type SnapshotRevision,
  type SnapshotSourceResult,
} from "../src/providers/snapshot/source.js";

const TORN_FILE_MESSAGE = "Snapshot file changed while being read.";

/** One live, non-aborted signal for a read that should not be interrupted. */
function liveSignal(): AbortSignal {
  return new AbortController().signal;
}

/** Assert a thrown value is a typed refusal with the given code and message. */
async function expectFailure(
  operation: Promise<unknown>,
  code: string,
  message?: string,
): Promise<SnapshotReadFailure> {
  const error = await operation.then(
    () => {
      throw new Error("expected the read to reject");
    },
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(SnapshotReadFailure);
  const failure = error as SnapshotReadFailure;
  expect(failure.code).toBe(code);
  if (message !== undefined) expect(failure.message).toBe(message);
  return failure;
}

/** Narrow a source result to the changed variant. */
function expectChanged(
  result: SnapshotSourceResult,
): Extract<SnapshotSourceResult, { changed: true }> {
  expect(result.changed).toBe(true);
  if (!result.changed) throw new Error("unreachable");
  return result;
}

/** Encode UTF-8 text to the byte form an HTTP body would carry. */
function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** A body stream that records whether it was pulled from and whether it was cancelled. */
interface TrackedBody {
  readonly stream: ReadableStream<Uint8Array>;
  pulled(): number;
  cancelled(): boolean;
}

function trackedBody(chunks: Uint8Array[]): TrackedBody {
  let index = 0;
  let pulls = 0;
  let wasCancelled = false;
  // highWaterMark 0 keeps `pull` demand-driven, so `pulls` reflects real reads
  // rather than the one eager fill a default queuing strategy performs.
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        pulls += 1;
        if (index < chunks.length) controller.enqueue(chunks[index++]);
        else controller.close();
      },
      cancel() {
        wasCancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, pulled: () => pulls, cancelled: () => wasCancelled };
}

/** Build a minimal `Response`-shaped object with full control over status/headers/body. */
function fakeResponse(init: {
  status: number;
  headers?: Record<string, string>;
  body?: ReadableStream<Uint8Array> | null;
}): Response {
  return {
    status: init.status,
    headers: new Headers(init.headers ?? {}),
    body: init.body ?? null,
  } as unknown as Response;
}

/** Read the request headers passed to the injected fetch on its Nth call. */
function requestHeaders(calls: readonly (readonly unknown[])[], call: number): Headers {
  const init = calls[call]?.[1] as RequestInit | undefined;
  return new Headers(init?.headers);
}

const URL_SOURCE = "https://example.invalid/snapshot.json";

describe("createSnapshotSource — construction and scheme handling", () => {
  const dirs: string[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "deck-snap-"));
    dirs.push(dir);
    return dir;
  }

  it("rejects empty and whitespace-only input as SOURCE_UNREADABLE", () => {
    for (const value of ["", "   ", "\t\n"]) {
      expect(() => createSnapshotSource(value)).toThrowError(SnapshotReadFailure);
      try {
        createSnapshotSource(value);
      } catch (error) {
        expect((error as SnapshotReadFailure).code).toBe("SOURCE_UNREADABLE");
      }
    }
  });

  it("rejects unsupported URI schemes with a sanitized protocol token", () => {
    for (const [value, protocol] of [
      ["file:///etc/deck/snapshot.json", "file"],
      ["ftp://example.invalid/snapshot.json", "ftp"],
      ["s3://bucket/snapshot.json", "s3"],
    ] as const) {
      let thrown: SnapshotReadFailure | undefined;
      try {
        createSnapshotSource(value);
      } catch (error) {
        thrown = error as SnapshotReadFailure;
      }
      expect(thrown?.code).toBe("SOURCE_PROTOCOL_UNSUPPORTED");
      expect(thrown?.message).toBe(
        SNAPSHOT_READ_MESSAGES.SOURCE_PROTOCOL_UNSUPPORTED.replace("<protocol>", protocol),
      );
      // The message names only the protocol token, never the full source value.
      expect(thrown?.message).not.toContain(value);
      expect(thrown?.message).not.toContain("etc/deck");
      expect(thrown?.message).not.toContain("bucket");
    }
  });

  it("accepts http and https URLs as url-kind sources without rejecting", () => {
    for (const value of ["http://example.invalid/snapshot.json", "HTTPS://example.invalid/s.json"]) {
      const source = createSnapshotSource(value);
      expect(source.kind).toBe("url");
    }
  });

  it("maps malformed HTTP URLs to SOURCE_UNREADABLE without retaining parser details", () => {
    const configured = "http://[invalid-host/snapshot.json";
    let thrown: SnapshotReadFailure | undefined;
    try {
      createSnapshotSource(configured);
    } catch (error) {
      thrown = error as SnapshotReadFailure;
    }
    expect(thrown).toBeInstanceOf(SnapshotReadFailure);
    expect(thrown?.code).toBe("SOURCE_UNREADABLE");
    expect(thrown?.message).toBe(SNAPSHOT_READ_MESSAGES.SOURCE_UNREADABLE);
    expect(thrown?.cause).toBeUndefined();
    expect(JSON.stringify(thrown)).not.toContain(configured);
    expect(JSON.stringify(thrown?.toPublic())).not.toContain(configured);
  });

  it("rejects an invalid maxBytes override as INTERNAL", () => {
    const dir = tempDir();
    const path = join(dir, "snapshot.json");
    writeFileSync(path, "{}");
    for (const maxBytes of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      let thrown: SnapshotReadFailure | undefined;
      try {
        createSnapshotSource(path, { maxBytes });
      } catch (error) {
        thrown = error as SnapshotReadFailure;
      }
      expect(thrown?.code).toBe("INTERNAL");
    }
  });

  it("resolves a relative path once, at construction, to an absolute target", async () => {
    const dir = tempDir();
    const absolute = join(dir, "snapshot.json");
    writeFileSync(absolute, '{"schemaVersion":1}');

    // The resolved value is captured at construction; force it to a known
    // absolute path so the read need not depend on the worker's cwd.
    vi.mocked(nodePath.resolve).mockReturnValueOnce(absolute);
    const before = vi.mocked(nodePath.resolve).mock.calls.length;
    const source = createSnapshotSource("relative/snapshot.json");
    const afterConstruction = vi.mocked(nodePath.resolve).mock.calls.length;
    expect(afterConstruction).toBe(before + 1);

    // Two reads reuse the captured absolute path without resolving again.
    const first = expectChanged(await source.read(liveSignal()));
    expect(first.text).toBe('{"schemaVersion":1}');
    source.accept(first.revision);
    await source.read(liveSignal());
    expect(vi.mocked(nodePath.resolve).mock.calls.length).toBe(afterConstruction);
  });

  it("exposes no configured path through the source object", () => {
    const dir = tempDir();
    const path = join(dir, "secret-snapshot.json");
    writeFileSync(path, "{}");
    const source = createSnapshotSource(path);
    expect(source.kind).toBe("path");
    expect(Object.keys(source).sort()).toEqual(["accept", "kind", "read"].sort());
    expect(JSON.stringify(source)).not.toContain("secret-snapshot");
    expect(JSON.stringify(source)).not.toContain(path);
  });
});

describe("bounded file source — reads and change detection", () => {
  const dirs: string[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function fileWith(content: string): string {
    const dir = mkdtempSync(join(tmpdir(), "deck-snap-"));
    dirs.push(dir);
    const path = join(dir, "snapshot.json");
    writeFileSync(path, content);
    return path;
  }

  it("returns changed text and a path-kind revision for a fresh read", async () => {
    const source = createSnapshotSource(fileWith('{"schemaVersion":1}'));
    const result = expectChanged(await source.read(liveSignal()));
    expect(result.text).toBe('{"schemaVersion":1}');
    expect(result.bytes).toBe(Buffer.byteLength('{"schemaVersion":1}', "utf8"));
    expect(result.revision.sourceKind).toBe("path");
    expect(typeof result.revision.token).toBe("symbol");
  });

  it("MAX_SNAPSHOT_BYTES is exactly 50 MiB", () => {
    expect(MAX_SNAPSHOT_BYTES).toBe(50 * 1024 * 1024);
  });

  it("skips open/read for an accepted unchanged (mtimeMs,size) tuple", async () => {
    const path = fileWith('{"schemaVersion":1}');
    const source = createSnapshotSource(path);

    const first = expectChanged(await source.read(liveSignal()));
    source.accept(first.revision);

    // Make the file unopenable while its stat tuple is unchanged; the unchanged
    // fast path stats only and must not attempt to open the stream.
    chmodSync(path, 0o000);
    try {
      const second = await source.read(liveSignal());
      expect(second.changed).toBe(false);
      expect(second.bytes).toBe(Buffer.byteLength('{"schemaVersion":1}', "utf8"));
    } finally {
      chmodSync(path, 0o644);
    }
  });

  it("re-reads changed content and treats an accepted-then-modified tuple as changed", async () => {
    const path = fileWith('{"v":1}');
    const source = createSnapshotSource(path);
    const first = expectChanged(await source.read(liveSignal()));
    source.accept(first.revision);

    // A distinct size guarantees a different tuple even at coarse mtime resolution.
    writeFileSync(path, '{"version":22}');
    const second = expectChanged(await source.read(liveSignal()));
    expect(second.text).toBe('{"version":22}');
  });

  it("maps missing files and non-file paths to SOURCE_UNREADABLE without leaking the path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "deck-snap-"));
    dirs.push(dir);
    const missing = join(dir, "does-not-exist.json");
    const source = createSnapshotSource(missing);
    const failure = await expectFailure(
      source.read(liveSignal()),
      "SOURCE_UNREADABLE",
      SNAPSHOT_READ_MESSAGES.SOURCE_UNREADABLE,
    );
    expect(JSON.stringify(failure.toPublic())).not.toContain("does-not-exist");

    // A directory path is not a file.
    const dirSource = createSnapshotSource(dir);
    await expectFailure(dirSource.read(liveSignal()), "SOURCE_UNREADABLE");
  });

  it("throws POLL_TIMEOUT for an already-aborted signal before any filesystem access", async () => {
    const source = createSnapshotSource(fileWith("{}"));
    const controller = new AbortController();
    controller.abort();
    const before = vi.mocked(fsPromises.stat).mock.calls.length;
    await expectFailure(
      source.read(controller.signal),
      "POLL_TIMEOUT",
      SNAPSHOT_READ_MESSAGES.POLL_TIMEOUT,
    );
    // The aborted read short-circuits before any stat call.
    expect(vi.mocked(fsPromises.stat).mock.calls.length).toBe(before);
  });

  it("maps an abort during file streaming to POLL_TIMEOUT", async () => {
    const path = fileWith('{"schemaVersion":1}');
    const controller = new AbortController();
    let pushed = false;
    const stream = new Readable({
      read() {
        if (pushed) return;
        pushed = true;
        this.push(Buffer.from("{"));
        queueMicrotask(() => controller.abort());
      },
    });
    vi.mocked(createReadStream).mockReturnValueOnce(
      stream as unknown as ReturnType<typeof createReadStream>,
    );

    const failure = await expectFailure(
      createSnapshotSource(path).read(controller.signal),
      "POLL_TIMEOUT",
      SNAPSHOT_READ_MESSAGES.POLL_TIMEOUT,
    );
    expect(failure.cause).toBeUndefined();
    expect(JSON.stringify(failure.toPublic())).not.toContain(path);
  });

  it("maps file stream open/read errors to SOURCE_UNREADABLE without leaking details", async () => {
    const path = fileWith('{"schemaVersion":1}');
    const upstream = `read failed for ${path}`;
    const stream = new Readable({
      read() {
        this.destroy(new Error(upstream));
      },
    });
    vi.mocked(createReadStream).mockReturnValueOnce(
      stream as unknown as ReturnType<typeof createReadStream>,
    );

    const failure = await expectFailure(
      createSnapshotSource(path).read(liveSignal()),
      "SOURCE_UNREADABLE",
      SNAPSHOT_READ_MESSAGES.SOURCE_UNREADABLE,
    );
    expect(failure.cause).toBeUndefined();
    expect(JSON.stringify(failure)).not.toContain(upstream);
    expect(JSON.stringify(failure.toPublic())).not.toContain(path);
  });
});

describe("bounded file source — size cap enforcement", () => {
  const dirs: string[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function fileOfBytes(byteCount: number): string {
    const dir = mkdtempSync(join(tmpdir(), "deck-snap-"));
    dirs.push(dir);
    const path = join(dir, "snapshot.json");
    writeFileSync(path, Buffer.alloc(byteCount, 0x61));
    return path;
  }

  it("rejects a declared oversize before opening with attemptedBytes equal to the declared size", async () => {
    const size = 4096;
    const path = fileOfBytes(size);
    const source = createSnapshotSource(path, { maxBytes: 1024 });
    const failure = await expectFailure(
      source.read(liveSignal()),
      "DOCUMENT_TOO_LARGE",
      SNAPSHOT_READ_MESSAGES.DOCUMENT_TOO_LARGE,
    );
    expect(failure.details.attemptedBytes).toBe(size);
    // The internal attempted-byte count is never serialized publicly.
    expect(JSON.stringify(failure.toPublic())).not.toContain(String(size));
  });

  it("stops streaming growth no later than maxBytes plus one chunk with exact accounting", async () => {
    // A 200 KiB real file with a stat that under-reports its size (a file that
    // grows after stat) forces the streaming cap rather than the declared check.
    const maxBytes = 100 * 1024;
    const path = fileOfBytes(200 * 1024);
    vi.mocked(fsPromises.stat).mockResolvedValueOnce({
      mtimeMs: 1000,
      size: 50 * 1024,
      isFile: () => true,
    } as unknown as Awaited<ReturnType<typeof fsPromises.stat>>);

    const source = createSnapshotSource(path, { maxBytes });
    const failure = await expectFailure(
      source.read(liveSignal()),
      "DOCUMENT_TOO_LARGE",
      SNAPSHOT_READ_MESSAGES.DOCUMENT_TOO_LARGE,
    );
    const attempted = failure.details.attemptedBytes ?? 0;
    expect(attempted).toBeGreaterThan(maxBytes);
    expect(attempted).toBeLessThanOrEqual(maxBytes + 64 * 1024);
    // Chunks arrive in 64 KiB units: cumulative crosses the cap at 128 KiB.
    expect(attempted).toBe(128 * 1024);
  });
});

describe("bounded file source — torn write refusal", () => {
  const dirs: string[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("refuses a pre/post-stat mismatch with the exact torn-file message", async () => {
    const dir = mkdtempSync(join(tmpdir(), "deck-snap-"));
    dirs.push(dir);
    const path = join(dir, "snapshot.json");
    writeFileSync(path, '{"schemaVersion":1}');
    const size = Buffer.byteLength('{"schemaVersion":1}', "utf8");

    // Pre-read stat and post-read stat report different mtimes for the same file.
    vi.mocked(fsPromises.stat)
      .mockResolvedValueOnce({
        mtimeMs: 1000,
        size,
        isFile: () => true,
      } as unknown as Awaited<ReturnType<typeof fsPromises.stat>>)
      .mockResolvedValueOnce({
        mtimeMs: 2000,
        size,
        isFile: () => true,
      } as unknown as Awaited<ReturnType<typeof fsPromises.stat>>);

    const source = createSnapshotSource(path);
    const failure = await expectFailure(source.read(liveSignal()), "SOURCE_UNREADABLE", TORN_FILE_MESSAGE);
    expect(failure.message).toBe(TORN_FILE_MESSAGE);
    expect(JSON.stringify(failure.toPublic())).not.toContain(path);
  });
});

describe("bounded file source — revision acceptance", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function fileWith(content: string): string {
    const dir = mkdtempSync(join(tmpdir(), "deck-snap-"));
    dirs.push(dir);
    const path = join(dir, "snapshot.json");
    writeFileSync(path, content);
    return path;
  }

  it("accepts only the latest revision and rejects superseded and foreign tokens", async () => {
    const path = fileWith('{"a":1}');
    const source = createSnapshotSource(path);

    const first = expectChanged(await source.read(liveSignal()));
    // Reading again without accepting yields a new pending revision that
    // supersedes the first.
    const second = expectChanged(await source.read(liveSignal()));

    // The superseded first token can no longer be accepted.
    expect(() => source.accept(first.revision)).toThrowError(SnapshotReadFailure);
    try {
      source.accept(first.revision);
    } catch (error) {
      expect((error as SnapshotReadFailure).code).toBe("INTERNAL");
    }

    // The latest token commits, and re-accepting it is a no-op.
    expect(() => source.accept(second.revision)).not.toThrow();
    expect(() => source.accept(second.revision)).not.toThrow();

    // A foreign token from another adapter kind is rejected.
    const foreign: SnapshotRevision = { sourceKind: "url", token: Symbol("foreign") };
    try {
      source.accept(foreign);
      throw new Error("expected rejection");
    } catch (error) {
      expect((error as SnapshotReadFailure).code).toBe("INTERNAL");
    }

    // A path-kind token that this adapter never issued is also rejected.
    const stranger: SnapshotRevision = { sourceKind: "path", token: Symbol("stranger") };
    try {
      source.accept(stranger);
      throw new Error("expected rejection");
    } catch (error) {
      expect((error as SnapshotReadFailure).code).toBe("INTERNAL");
    }
  });

  it("retries an unaccepted candidate at the same validator because reading never commits", async () => {
    const path = fileWith('{"invalid": true}');
    const source = createSnapshotSource(path);

    // Simulate the provider reading an invalid document and never accepting it.
    const first = expectChanged(await source.read(liveSignal()));
    expect(first.text).toBe('{"invalid": true}');

    // The same unchanged file is still a changed read: reading alone did not
    // commit the validator, so the invalid content is retried.
    const second = expectChanged(await source.read(liveSignal()));
    expect(second.text).toBe('{"invalid": true}');

    // Once accepted, the unchanged tuple takes the fast path.
    source.accept(second.revision);
    const third = await source.read(liveSignal());
    expect(third.changed).toBe(false);
  });
});

describe("bounded HTTP source — request shape and conditional headers", () => {
  it("issues exactly one GET with the supplied signal and no credentials or body", async () => {
    const fetchMock = vi.fn(async () =>
      fakeResponse({ status: 200, body: trackedBody([bytes('{"schemaVersion":1}')]).stream }),
    );
    const source = createSnapshotSource(URL_SOURCE, { fetch: fetchMock });
    const signal = liveSignal();

    const result = expectChanged(await source.read(signal));
    expect(result.text).toBe('{"schemaVersion":1}');
    expect(result.bytes).toBe(Buffer.byteLength('{"schemaVersion":1}', "utf8"));
    expect(result.revision.sourceKind).toBe("url");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(calledUrl)).toBe(URL_SOURCE);
    expect(init.method).toBe("GET");
    expect(init.signal).toBe(signal);
    expect(init.body).toBeUndefined();
    expect("credentials" in init).toBe(false);

    // A first read has no accepted validators, so it sends no conditional headers.
    const headers = requestHeaders(fetchMock.mock.calls, 0);
    expect(headers.has("if-none-match")).toBe(false);
    expect(headers.has("if-modified-since")).toBe(false);
  });

  it("sends exact conditional headers only after an accepted response supplies validators", async () => {
    const lastModified = "Wed, 21 Oct 2030 07:28:00 GMT";
    const fetchMock = vi.fn(async () =>
      fakeResponse({
        status: 200,
        headers: { etag: '"abc"', "last-modified": lastModified },
        body: trackedBody([bytes('{"schemaVersion":1}')]).stream,
      }),
    );
    const source = createSnapshotSource(URL_SOURCE, { fetch: fetchMock });

    expectChanged(await source.read(liveSignal()));
    expect(requestHeaders(fetchMock.mock.calls, 0).has("if-none-match")).toBe(false);

    // Reading again without accepting must not commit the candidate validators.
    const second = expectChanged(await source.read(liveSignal()));
    expect(requestHeaders(fetchMock.mock.calls, 1).has("if-none-match")).toBe(false);

    // Accepting the latest revision commits its validators for the next request.
    source.accept(second.revision);
    await source.read(liveSignal());
    const headers = requestHeaders(fetchMock.mock.calls, 2);
    expect(headers.get("if-none-match")).toBe('"abc"');
    expect(headers.get("if-modified-since")).toBe(lastModified);
  });

  it("treats 304 as unchanged with zero bytes and never reads the body", async () => {
    const notModifiedBody = trackedBody([bytes("must-not-be-read")]);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        fakeResponse({
          status: 200,
          headers: { etag: '"v1"' },
          body: trackedBody([bytes('{"schemaVersion":1}')]).stream,
        }),
      )
      .mockResolvedValueOnce(
        fakeResponse({ status: 304, body: notModifiedBody.stream }),
      );
    const source = createSnapshotSource(URL_SOURCE, { fetch: fetchMock });

    const first = expectChanged(await source.read(liveSignal()));
    source.accept(first.revision);

    const second = await source.read(liveSignal());
    expect(second.changed).toBe(false);
    expect(second.bytes).toBe(0);
    expect(notModifiedBody.pulled()).toBe(0);
    expect(requestHeaders(fetchMock.mock.calls, 1).get("if-none-match")).toBe('"v1"');
  });

  it("without validators every 2xx response is changed and sends no conditional headers", async () => {
    const fetchMock = vi.fn(async () =>
      fakeResponse({ status: 200, body: trackedBody([bytes('{"schemaVersion":1}')]).stream }),
    );
    const source = createSnapshotSource(URL_SOURCE, { fetch: fetchMock });

    const first = expectChanged(await source.read(liveSignal()));
    source.accept(first.revision);

    const second = expectChanged(await source.read(liveSignal()));
    expect(second.text).toBe('{"schemaVersion":1}');
    const headers = requestHeaders(fetchMock.mock.calls, 1);
    expect(headers.has("if-none-match")).toBe(false);
    expect(headers.has("if-modified-since")).toBe(false);
  });
});

describe("bounded HTTP source — safe failure mapping", () => {
  it("maps every non-2xx status to HTTP_STATUS with the numeric status only", async () => {
    for (const status of [400, 404, 418, 500, 503]) {
      const fetchMock = vi.fn(async () => fakeResponse({ status }));
      const source = createSnapshotSource(URL_SOURCE, { fetch: fetchMock });
      const failure = await expectFailure(
        source.read(liveSignal()),
        "HTTP_STATUS",
        SNAPSHOT_READ_MESSAGES.HTTP_STATUS.replace("<status>", String(status)),
      );
      expect(failure.details.httpStatus).toBe(status);
      expect(failure.toPublic().httpStatus).toBe(status);
      // Only the numeric status is public; internal byte accounting is not serialized.
      expect(JSON.stringify(failure.toPublic())).not.toContain("attemptedBytes");
    }
  });

  it("maps a transport failure to SOURCE_UNREADABLE without upstream text", async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError("getaddrinfo ENOTFOUND internal-secret-host.invalid");
    });
    const source = createSnapshotSource(URL_SOURCE, { fetch: fetchMock });
    const failure = await expectFailure(
      source.read(liveSignal()),
      "SOURCE_UNREADABLE",
      SNAPSHOT_READ_MESSAGES.SOURCE_UNREADABLE,
    );
    expect(failure.message).not.toContain("internal-secret-host");
    expect(failure.message).not.toContain("ENOTFOUND");
    expect(JSON.stringify(failure.toPublic())).not.toContain("ENOTFOUND");
  });

  it("maps a null body on a changed 2xx response to SOURCE_UNREADABLE", async () => {
    const fetchMock = vi.fn(async () => fakeResponse({ status: 200, body: null }));
    const source = createSnapshotSource(URL_SOURCE, { fetch: fetchMock });
    await expectFailure(
      source.read(liveSignal()),
      "SOURCE_UNREADABLE",
      SNAPSHOT_READ_MESSAGES.SOURCE_UNREADABLE,
    );
  });

  it("throws POLL_TIMEOUT for an already-aborted signal before calling fetch", async () => {
    const fetchMock = vi.fn(async () => fakeResponse({ status: 200, body: null }));
    const source = createSnapshotSource(URL_SOURCE, { fetch: fetchMock });
    const controller = new AbortController();
    controller.abort();
    await expectFailure(
      source.read(controller.signal),
      "POLL_TIMEOUT",
      SNAPSHOT_READ_MESSAGES.POLL_TIMEOUT,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps an abort during fetch to POLL_TIMEOUT", async () => {
    const fetchMock = vi.fn(async () => {
      const error = new Error("The operation was aborted");
      error.name = "AbortError";
      throw error;
    });
    const source = createSnapshotSource(URL_SOURCE, { fetch: fetchMock });
    await expectFailure(
      source.read(liveSignal()),
      "POLL_TIMEOUT",
      SNAPSHOT_READ_MESSAGES.POLL_TIMEOUT,
    );
  });

  it("maps an abort during body consumption to POLL_TIMEOUT", async () => {
    const abortingBody = new ReadableStream<Uint8Array>({
      pull() {
        const error = new Error("aborted during body");
        error.name = "AbortError";
        throw error;
      },
    });
    const fetchMock = vi.fn(async () => fakeResponse({ status: 200, body: abortingBody }));
    const source = createSnapshotSource(URL_SOURCE, { fetch: fetchMock });
    await expectFailure(
      source.read(liveSignal()),
      "POLL_TIMEOUT",
      SNAPSHOT_READ_MESSAGES.POLL_TIMEOUT,
    );
  });
});

describe("bounded HTTP source — size cap enforcement", () => {
  it("rejects a valid oversized Content-Length before consuming the body", async () => {
    const declared = 200 * 1024;
    const body = trackedBody([bytes("x".repeat(64 * 1024))]);
    const fetchMock = vi.fn(async () =>
      fakeResponse({
        status: 200,
        headers: { "content-length": String(declared) },
        body: body.stream,
      }),
    );
    const source = createSnapshotSource(URL_SOURCE, { fetch: fetchMock, maxBytes: 100 * 1024 });
    const failure = await expectFailure(
      source.read(liveSignal()),
      "DOCUMENT_TOO_LARGE",
      SNAPSHOT_READ_MESSAGES.DOCUMENT_TOO_LARGE,
    );
    expect(failure.details.attemptedBytes).toBe(declared);
    // The declared size is neither consumed nor serialized publicly.
    expect(body.pulled()).toBe(0);
    expect(body.cancelled()).toBe(true);
    expect(JSON.stringify(failure.toPublic())).not.toContain(String(declared));
  });

  it("still streams when Content-Length is missing or malformed", async () => {
    for (const contentLength of [undefined, "", "not-a-number", "-5", "12.5", "0x10"]) {
      const headers: Record<string, string> =
        contentLength === undefined ? {} : { "content-length": contentLength };
      const fetchMock = vi.fn(async () =>
        fakeResponse({
          status: 200,
          headers,
          body: trackedBody([bytes('{"schemaVersion":1}')]).stream,
        }),
      );
      const source = createSnapshotSource(URL_SOURCE, { fetch: fetchMock });
      const result = expectChanged(await source.read(liveSignal()));
      expect(result.text).toBe('{"schemaVersion":1}');
    }
  });

  it("cancels a streamed oversize no later than maxBytes plus one chunk with exact accounting", async () => {
    const maxBytes = 100 * 1024;
    const chunk = new Uint8Array(64 * 1024);
    // Four 64 KiB chunks; cumulative crosses the 100 KiB cap at the second chunk.
    const body = trackedBody([chunk, chunk, chunk, chunk]);
    const fetchMock = vi.fn(async () => fakeResponse({ status: 200, body: body.stream }));
    const source = createSnapshotSource(URL_SOURCE, { fetch: fetchMock, maxBytes });

    const failure = await expectFailure(
      source.read(liveSignal()),
      "DOCUMENT_TOO_LARGE",
      SNAPSHOT_READ_MESSAGES.DOCUMENT_TOO_LARGE,
    );
    const attempted = failure.details.attemptedBytes ?? 0;
    expect(attempted).toBeGreaterThan(maxBytes);
    expect(attempted).toBeLessThanOrEqual(maxBytes + 64 * 1024);
    expect(attempted).toBe(128 * 1024);
    expect(body.cancelled()).toBe(true);
  });
});

describe("bounded HTTP source — revision acceptance", () => {
  it("retries an unaccepted invalid body at the same validator and accepts valid content later", async () => {
    // Every call returns the same ETag; the provider reads twice without accepting,
    // then accepts, after which the server can answer conditionally with 304.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        fakeResponse({
          status: 200,
          headers: { etag: '"v1"' },
          body: trackedBody([bytes('{"invalid":true}')]).stream,
        }),
      )
      .mockResolvedValueOnce(
        fakeResponse({
          status: 200,
          headers: { etag: '"v1"' },
          body: trackedBody([bytes('{"invalid":true}')]).stream,
        }),
      )
      .mockResolvedValueOnce(fakeResponse({ status: 304 }));
    const source = createSnapshotSource(URL_SOURCE, { fetch: fetchMock });

    const first = expectChanged(await source.read(liveSignal()));
    expect(first.text).toBe('{"invalid":true}');
    expect(requestHeaders(fetchMock.mock.calls, 0).has("if-none-match")).toBe(false);

    // Reading again without accepting did not commit the validator.
    const second = expectChanged(await source.read(liveSignal()));
    expect(second.text).toBe('{"invalid":true}');
    expect(requestHeaders(fetchMock.mock.calls, 1).has("if-none-match")).toBe(false);

    // Once accepted, the committed validator drives a conditional request.
    source.accept(second.revision);
    const third = await source.read(liveSignal());
    expect(third.changed).toBe(false);
    expect(requestHeaders(fetchMock.mock.calls, 2).get("if-none-match")).toBe('"v1"');
  });

  it("accepts only the latest revision and rejects superseded and foreign tokens", async () => {
    const fetchMock = vi.fn(async () =>
      fakeResponse({
        status: 200,
        headers: { etag: '"v1"' },
        body: trackedBody([bytes('{"schemaVersion":1}')]).stream,
      }),
    );
    const source = createSnapshotSource(URL_SOURCE, { fetch: fetchMock });

    const first = expectChanged(await source.read(liveSignal()));
    const second = expectChanged(await source.read(liveSignal()));

    // The superseded first token can no longer be accepted.
    try {
      source.accept(first.revision);
      throw new Error("expected rejection");
    } catch (error) {
      expect((error as SnapshotReadFailure).code).toBe("INTERNAL");
    }

    // The latest token commits, and re-accepting it is a no-op.
    expect(() => source.accept(second.revision)).not.toThrow();
    expect(() => source.accept(second.revision)).not.toThrow();

    // A foreign token from the file adapter kind is rejected.
    const foreign: SnapshotRevision = { sourceKind: "path", token: Symbol("foreign") };
    try {
      source.accept(foreign);
      throw new Error("expected rejection");
    } catch (error) {
      expect((error as SnapshotReadFailure).code).toBe("INTERNAL");
    }

    // A url-kind token this adapter never issued is also rejected.
    const stranger: SnapshotRevision = { sourceKind: "url", token: Symbol("stranger") };
    try {
      source.accept(stranger);
      throw new Error("expected rejection");
    } catch (error) {
      expect((error as SnapshotReadFailure).code).toBe("INTERNAL");
    }
  });
});
