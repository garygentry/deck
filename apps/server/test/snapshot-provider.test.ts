import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Wrap the source-verified validator in a call-through spy so tests can prove it
// runs exactly once for a changed read and never for an unchanged read, while
// preserving its real classification behavior.
vi.mock("@deck/schema", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@deck/schema")>();
  return { ...actual, validateSnapshot: vi.fn(actual.validateSnapshot) };
});

import type { ProviderKindContext } from "@deck/module-sdk";
import { validateSnapshot, type DeckConfigDocument } from "@deck/schema";

import { POLL_DEFAULTS, type ProviderFetchContext } from "../src/contract/index.js";
import { logger, type SnapshotReadEvent } from "../src/log/logger.js";
import { SNAPSHOT_READ_MESSAGES, SnapshotReadFailure } from "../src/providers/snapshot/errors.js";
import { SnapshotProvider } from "../src/providers/snapshot/index.js";
import { snapshotModule } from "../src/providers/snapshot/module.js";
import type {
  SnapshotRevision,
  SnapshotSource,
  SnapshotSourceResult,
} from "../src/providers/snapshot/source.js";

/** A configured host declared in the estate. */
const config = {
  schemaVersion: 2,
  estate: { name: "example-estate", freshness: { snapshotStaleAfter: "PT6H" } },
  hosts: [{ name: "host-a", kind: "vm", purpose: "Example workload" }],
} satisfies DeckConfigDocument;

const COLLECTED_AT = "2030-01-01T00:00:00.000Z";

/** A valid classification-0 snapshot for `host-a`, carrying a resolvable drift. */
function cleanSnapshotJson(): string {
  return JSON.stringify({
    schemaVersion: 1,
    generatedAt: COLLECTED_AT,
    hosts: [{ name: "host-a", coverage: "collected", collectedAt: COLLECTED_AT }],
    drift: [
      {
        id: "d1",
        severity: "warning",
        location: { host: "host-a" },
        category: "config",
        message: "example drift",
      },
    ],
  });
}

/** A valid snapshot whose extra observed host yields a classification-1 finding. */
function findingsSnapshotJson(): string {
  return JSON.stringify({
    schemaVersion: 1,
    generatedAt: COLLECTED_AT,
    hosts: [
      { name: "host-a", coverage: "collected", collectedAt: COLLECTED_AT },
      { name: "host-b", coverage: "collected", collectedAt: COLLECTED_AT },
    ],
  });
}

/** A structurally valid snapshot at an unsupported schema version. */
function unsupportedVersionJson(): string {
  return JSON.stringify({ schemaVersion: 999, generatedAt: COLLECTED_AT, hosts: [] });
}

let revisionCounter = 0;
function nextRevision(): SnapshotRevision {
  revisionCounter += 1;
  return { sourceKind: "path", token: Symbol(`rev-${revisionCounter}`) };
}

function changed(text: string, revision: SnapshotRevision = nextRevision()): SnapshotSourceResult {
  return { changed: true, bytes: Buffer.byteLength(text), text, revision };
}

function unchanged(bytes = 0): SnapshotSourceResult {
  return { changed: false, bytes };
}

/** A deterministic source that replays queued outcomes and records acceptance. */
class FakeSource implements SnapshotSource {
  readonly kind = "path";
  readonly accepted: SnapshotRevision[] = [];
  readCalls = 0;

  constructor(private readonly outcomes: Array<SnapshotSourceResult | Error>) {}

  async read(signal: AbortSignal): Promise<SnapshotSourceResult> {
    this.readCalls += 1;
    if (signal.aborted) throw new SnapshotReadFailure("POLL_TIMEOUT", "aborted");
    const next = this.outcomes.shift();
    if (next === undefined) throw new Error("FakeSource: no more outcomes queued");
    if (next instanceof Error) throw next;
    return next;
  }

  accept(revision: SnapshotRevision): void {
    this.accepted.push(revision);
  }
}

function context(): ProviderFetchContext {
  return { signal: new AbortController().signal };
}

/** A clock returning each queued instant once, then repeating the last. */
function clock(times: string[]): () => Date {
  let index = 0;
  return () => new Date(times[Math.min(index++, times.length - 1)]);
}

async function expectRefusal(operation: Promise<unknown>, code: string): Promise<SnapshotReadFailure> {
  const error = await operation.then(
    () => {
      throw new Error("expected the fetch to reject");
    },
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(SnapshotReadFailure);
  const failure = error as SnapshotReadFailure;
  expect(failure.code).toBe(code);
  return failure;
}

/**
 * Spy on the shared logger and collect only the structured `snapshot.read`
 * events, so tests can prove exactly one is emitted per fetch with safe fields.
 */
function captureReadEvents(): { events: SnapshotReadEvent[] } {
  const events: SnapshotReadEvent[] = [];
  vi.spyOn(logger, "info").mockImplementation(((payload: unknown) => {
    if (
      typeof payload === "object" &&
      payload !== null &&
      (payload as { event?: unknown }).event === "snapshot.read"
    ) {
      events.push(payload as SnapshotReadEvent);
    }
    return logger;
  }) as typeof logger.info);
  return { events };
}

/** All strings that must never appear in a public error or a logged event. */
const FORBIDDEN_SENTINELS = [
  "FORBIDDEN_SENTINEL",
  "/secret/estate/snapshot.json",
  "body-excerpt-do-not-leak",
  "parser-position-42",
];

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SnapshotProvider.fetch — changed reads", () => {
  it("serves a clean classification-0 result with exactly five keys and preserved drift", async () => {
    const parseSpy = vi.spyOn(JSON, "parse");
    const source = new FakeSource([changed(cleanSnapshotJson())]);
    const provider = new SnapshotProvider("snapshot", {
      source,
      config,
      now: clock(["2030-01-01T01:00:00.000Z"]),
    });

    const result = await provider.fetch(context());

    expect(parseSpy).toHaveBeenCalledTimes(1);
    expect(vi.mocked(validateSnapshot)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(validateSnapshot).mock.calls[0]?.[1]).toBe(config);

    expect(Object.keys(result).sort()).toEqual([
      "findings",
      "hostStates",
      "lastReadAt",
      "readError",
      "snapshot",
    ]);
    expect(result.readError).toBeNull();
    expect(result.findings).toEqual([]);
    // The whole parsed document is retained, including drift.
    expect(result.snapshot.drift).toEqual([
      {
        id: "d1",
        severity: "warning",
        location: { host: "host-a" },
        category: "config",
        message: "example drift",
      },
    ]);
    expect(result.hostStates["host-a"]?.state).toBe("fresh");
    expect(result.lastReadAt).toBe("2030-01-01T01:00:00.000Z");

    // A full changed success accepts the candidate revision exactly once.
    expect(source.accepted).toHaveLength(1);

    const health = await provider.health();
    expect(health).toEqual({ ok: true, detail: "Snapshot clean" });
  });

  it("serves a classification-1 result and reports it in health without refusing", async () => {
    const source = new FakeSource([changed(findingsSnapshotJson())]);
    const provider = new SnapshotProvider("snapshot", { source, config });

    const result = await provider.fetch(context());

    expect(result.readError).toBeNull();
    expect(result.findings.length).toBeGreaterThan(0);
    expect(result.findings.some((finding) => finding.code === "SNAPSHOT_HOST_UNDECLARED")).toBe(true);
    expect(source.accepted).toHaveLength(1);

    const health = await provider.health();
    expect(health.ok).toBe(true);
    expect(health.detail).toBe(`Snapshot accepted with ${result.findings.length} finding(s)`);
  });

  it("refuses malformed JSON as JSON_INVALID without accepting the revision", async () => {
    const source = new FakeSource([changed("{ not valid json")]);
    const provider = new SnapshotProvider("snapshot", { source, config });

    await expectRefusal(provider.fetch(context()), "JSON_INVALID");
    expect(source.accepted).toHaveLength(0);
    // Validation is never reached for unparseable text.
    expect(vi.mocked(validateSnapshot)).not.toHaveBeenCalled();
  });

  it("refuses an unsupported schema version with the exact sanitized message", async () => {
    const source = new FakeSource([changed(unsupportedVersionJson())]);
    const provider = new SnapshotProvider("snapshot", { source, config });

    const failure = await expectRefusal(provider.fetch(context()), "VERSION_UNSUPPORTED");
    expect(failure.message).toBe(
      "Snapshot schemaVersion 999 is unsupported; supported version(s): 1.",
    );
    expect(source.accepted).toHaveLength(0);
  });

  it("refuses classification 2 (tool error) as SNAPSHOT_INVALID without accepting", async () => {
    // A snapshot that is not an object drives the validator to classification 2.
    const source = new FakeSource([changed(JSON.stringify(42))]);
    const provider = new SnapshotProvider("snapshot", { source, config });

    await expectRefusal(provider.fetch(context()), "SNAPSHOT_INVALID");
    expect(source.accepted).toHaveLength(0);
  });

  it("refuses an invalid stale threshold before accepting the revision", async () => {
    const badConfig = {
      schemaVersion: 2,
      estate: { name: "e", freshness: { snapshotStaleAfter: "not-a-duration" } },
      hosts: [{ name: "host-a", kind: "vm", purpose: "p" }],
    } satisfies DeckConfigDocument;
    const source = new FakeSource([changed(cleanSnapshotJson())]);
    const provider = new SnapshotProvider("snapshot", { source, config: badConfig });

    await expectRefusal(provider.fetch(context()), "STALE_THRESHOLD_INVALID");
    // Parse and validation ran, but the revision is not accepted on a later failure.
    expect(vi.mocked(validateSnapshot)).toHaveBeenCalledTimes(1);
    expect(source.accepted).toHaveLength(0);
  });
});

describe("SnapshotProvider.fetch — unchanged reads", () => {
  it("reuses references, recomputes host ages, advances lastReadAt, and skips parse/validate", async () => {
    const source = new FakeSource([changed(cleanSnapshotJson()), unchanged(0)]);
    const provider = new SnapshotProvider("snapshot", {
      source,
      config,
      now: clock(["2030-01-01T01:00:00.000Z", "2030-01-01T02:00:00.000Z"]),
    });

    const first = await provider.fetch(context());

    vi.mocked(validateSnapshot).mockClear();
    const parseSpy = vi.spyOn(JSON, "parse");

    const second = await provider.fetch(context());

    // Neither the parser nor the validator runs on an unchanged read.
    expect(parseSpy).not.toHaveBeenCalled();
    expect(vi.mocked(validateSnapshot)).not.toHaveBeenCalled();

    // Snapshot and findings references are reused unchanged.
    expect(second.snapshot).toBe(first.snapshot);
    expect(second.findings).toBe(first.findings);

    // The successful read advances the read time and recomputes host ages.
    expect(second.lastReadAt).toBe("2030-01-01T02:00:00.000Z");
    expect(first.hostStates["host-a"]?.ageMs).toBe(60 * 60 * 1000);
    expect(second.hostStates["host-a"]?.ageMs).toBe(2 * 60 * 60 * 1000);
    expect(second.readError).toBeNull();

    // An unchanged confirmation does not re-accept a revision.
    expect(source.accepted).toHaveLength(1);
  });
});

describe("SnapshotProvider.fetch — revision acceptance", () => {
  it("accepts only after a full success, so an invalid document is retried later", async () => {
    const validRevision = nextRevision();
    const source = new FakeSource([
      changed("{ broken", nextRevision()),
      changed(cleanSnapshotJson(), validRevision),
    ]);
    const provider = new SnapshotProvider("snapshot", { source, config });

    // First read refuses; its candidate revision is never committed.
    await expectRefusal(provider.fetch(context()), "JSON_INVALID");
    expect(source.accepted).toHaveLength(0);

    // A later valid read at the source commits exactly its own revision.
    const result = await provider.fetch(context());
    expect(result.readError).toBeNull();
    expect(source.accepted).toEqual([validRevision]);
  });
});

describe("the snapshot module's kind handler", () => {
  const handler = snapshotModule.kinds!.snapshot!.instances!;
  const contextWith = (env: Record<string, string>) =>
    ({
      env: { get: (name: string) => env[name] },
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      envFor: () => ({ get: () => undefined }),
      estate: config,
    }) as unknown as ProviderKindContext;

  it("offers nothing when DECK_SNAPSHOT_SOURCE is unset", () => {
    expect(handler([], contextWith({}))).toEqual([]);
  });

  it("offers the fixed-id snapshot singleton with the exact engine policy", () => {
    const offers = handler([], contextWith({ DECK_SNAPSHOT_SOURCE: "/srv/snapshot.json" }));
    expect(offers).toHaveLength(1);
    const [offer] = offers;
    expect(offer!.provider).toBeInstanceOf(SnapshotProvider);
    expect(offer!.provider.id).toBe("snapshot");
    expect(offer!.provider.kind).toBe("snapshot");
    expect(offer!.fixedId).toBe(true);
    expect(offer!.timing).toEqual({
      pollIntervalMs: 60_000,
      ttlMs: 60_000,
      unreachableAfterMs: 180_000,
      timeoutMs: POLL_DEFAULTS.timeoutMs,
      failureFreshness: "age-retained",
    });
  });
});

describe("SnapshotProvider.health — non-I/O transitions", () => {
  it("transitions awaiting → clean → refused → recovered without any source read on health()", async () => {
    const source = new FakeSource([
      changed(cleanSnapshotJson()),
      changed("{ broken"),
      changed(cleanSnapshotJson()),
    ]);
    const provider = new SnapshotProvider("snapshot", { source, config });

    // Awaiting: initial non-I/O health before the first poll.
    expect(await provider.health()).toEqual({ ok: false, detail: "Awaiting first snapshot poll" });
    const readsAfterAwaiting = source.readCalls;
    await provider.health();
    await provider.health();
    // health() performs no source I/O.
    expect(source.readCalls).toBe(readsAfterAwaiting);

    // Clean success.
    await provider.fetch(context());
    expect(await provider.health()).toEqual({ ok: true, detail: "Snapshot clean" });

    // Refusal records a safe code, not ok.
    await expectRefusal(provider.fetch(context()), "JSON_INVALID");
    expect(await provider.health()).toEqual({ ok: false, detail: "JSON_INVALID" });

    // Recovered: a later success clears failure health.
    const readsBeforeRecovery = source.readCalls;
    await provider.fetch(context());
    expect(await provider.health()).toEqual({ ok: true, detail: "Snapshot clean" });
    // The recovery came from fetch, and health() itself added no reads.
    expect(source.readCalls).toBe(readsBeforeRecovery + 1);
  });

  it("reports the finding count in health for a classification-1 accepted read", async () => {
    const source = new FakeSource([changed(findingsSnapshotJson())]);
    const provider = new SnapshotProvider("snapshot", { source, config });

    const result = await provider.fetch(context());
    expect(await provider.health()).toEqual({
      ok: true,
      detail: `Snapshot accepted with ${result.findings.length} finding(s)`,
    });
  });
});

describe("SnapshotProvider.onFetchError — retention projection", () => {
  it("returns null before any successful read", () => {
    const provider = new SnapshotProvider("snapshot", { source: new FakeSource([]), config });
    expect(provider.onFetchError(new Error("boom"), null)).toBeNull();
  });

  it("preserves snapshot/findings/lastReadAt, recomputes ages, and sets a safe readError", async () => {
    const source = new FakeSource([changed(cleanSnapshotJson())]);
    const provider = new SnapshotProvider("snapshot", {
      source,
      config,
      now: clock(["2030-01-01T01:00:00.000Z", "2030-01-01T03:00:00.000Z"]),
    });

    const retained = await provider.fetch(context());
    expect(source.accepted).toHaveLength(1);
    const readsAfterSuccess = source.readCalls;

    const projected = provider.onFetchError(
      new SnapshotReadFailure("SOURCE_UNREADABLE", SNAPSHOT_READ_MESSAGES.SOURCE_UNREADABLE),
      retained,
    );

    expect(projected).not.toBeNull();
    const result = projected!;

    // Snapshot and findings references are retained unchanged.
    expect(result.snapshot).toBe(retained.snapshot);
    expect(result.findings).toBe(retained.findings);
    // Success time is never advanced by a failure projection.
    expect(result.lastReadAt).toBe(retained.lastReadAt);
    expect(result.lastReadAt).toBe("2030-01-01T01:00:00.000Z");
    // Host ages are recomputed against the later now().
    expect(retained.hostStates["host-a"]?.ageMs).toBe(60 * 60 * 1000);
    expect(result.hostStates["host-a"]?.ageMs).toBe(3 * 60 * 60 * 1000);
    // Only a safe read error is set.
    expect(result.readError).toEqual({
      code: "SOURCE_UNREADABLE",
      message: SNAPSHOT_READ_MESSAGES.SOURCE_UNREADABLE,
    });

    // The projection never reads the source and never accepts a revision.
    expect(source.readCalls).toBe(readsAfterSuccess);
    expect(source.accepted).toHaveLength(1);
  });

  it("normalizes an arbitrary error to a sanitized INTERNAL readError", async () => {
    const source = new FakeSource([changed(cleanSnapshotJson())]);
    const provider = new SnapshotProvider("snapshot", { source, config });
    const retained = await provider.fetch(context());

    const projected = provider.onFetchError(
      new Error("FORBIDDEN_SENTINEL /secret/estate/snapshot.json"),
      retained,
    );

    expect(projected?.readError).toEqual({
      code: "INTERNAL",
      message: SNAPSHOT_READ_MESSAGES.INTERNAL,
    });
    const serialized = JSON.stringify(projected);
    for (const sentinel of FORBIDDEN_SENTINELS) {
      expect(serialized).not.toContain(sentinel);
    }
  });
});

describe("SnapshotProvider.fetch — exactly-one snapshot.read event", () => {
  it("emits one clean event with safe fields and byte accounting", async () => {
    const { events } = captureReadEvents();
    const text = cleanSnapshotJson();
    const source = new FakeSource([changed(text)]);
    const provider = new SnapshotProvider("snapshot", { source, config });

    await provider.fetch(context());

    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.event).toBe("snapshot.read");
    expect(event.sourceKind).toBe("path");
    expect(event.outcome).toBe("clean");
    expect(event.findingsCount).toBe(0);
    expect(event.bytes).toBe(Buffer.byteLength(text));
    expect(event.failureClass).toBeUndefined();
    expect(event.httpStatus).toBeUndefined();
    expect(Number.isFinite(event.durationMs)).toBe(true);
    expect(event.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("emits one findings event with the accepted finding count", async () => {
    const { events } = captureReadEvents();
    const source = new FakeSource([changed(findingsSnapshotJson())]);
    const provider = new SnapshotProvider("snapshot", { source, config });

    const result = await provider.fetch(context());

    expect(events).toHaveLength(1);
    expect(events[0]!.outcome).toBe("findings");
    expect(events[0]!.findingsCount).toBe(result.findings.length);
    expect(events[0]!.findingsCount).toBeGreaterThan(0);
  });

  it("emits one unchanged event reusing the retained finding count", async () => {
    const { events } = captureReadEvents();
    const source = new FakeSource([changed(cleanSnapshotJson()), unchanged(128)]);
    const provider = new SnapshotProvider("snapshot", { source, config });

    await provider.fetch(context());
    await provider.fetch(context());

    expect(events).toHaveLength(2);
    const unchangedEvent = events[1]!;
    expect(unchangedEvent.outcome).toBe("unchanged");
    expect(unchangedEvent.findingsCount).toBe(0);
    expect(unchangedEvent.bytes).toBe(128);
  });

  it("emits one refused event for a declared-size overflow reporting declared bytes", async () => {
    const { events } = captureReadEvents();
    const oversize = new SnapshotReadFailure("DOCUMENT_TOO_LARGE", SNAPSHOT_READ_MESSAGES.DOCUMENT_TOO_LARGE, {
      attemptedBytes: 987_654,
    });
    const source = new FakeSource([oversize]);
    const provider = new SnapshotProvider("snapshot", { source, config });

    await expectRefusal(provider.fetch(context()), "DOCUMENT_TOO_LARGE");

    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.outcome).toBe("refused");
    expect(event.failureClass).toBe("DOCUMENT_TOO_LARGE");
    expect(event.findingsCount).toBe(0);
    expect(event.bytes).toBe(987_654);
    expect(event.httpStatus).toBeUndefined();
  });

  it("emits one refused event for an HTTP status carrying only the numeric status", async () => {
    const { events } = captureReadEvents();
    const httpFailure = new SnapshotReadFailure(
      "HTTP_STATUS",
      SNAPSHOT_READ_MESSAGES.HTTP_STATUS.replace("<status>", "503"),
      { httpStatus: 503, attemptedBytes: 0 },
    );
    const source = new FakeSource([httpFailure]);
    const provider = new SnapshotProvider("snapshot", { source, config });

    const failure = await expectRefusal(provider.fetch(context()), "HTTP_STATUS");
    expect(failure.message).toBe("Snapshot source returned HTTP 503; verify the remote snapshot endpoint.");

    expect(events).toHaveLength(1);
    expect(events[0]!.httpStatus).toBe(503);
    expect(events[0]!.bytes).toBe(0);
  });

  it("emits one refused event with zero bytes for an unknown failure", async () => {
    const { events } = captureReadEvents();
    const source = new FakeSource([new Error("unexpected explosion")]);
    const provider = new SnapshotProvider("snapshot", { source, config });

    await expectRefusal(provider.fetch(context()), "INTERNAL");

    expect(events).toHaveLength(1);
    expect(events[0]!.outcome).toBe("refused");
    expect(events[0]!.failureClass).toBe("INTERNAL");
    expect(events[0]!.bytes).toBe(0);
  });

  it("still emits exactly one event and preserves the outcome when logger.info throws", async () => {
    const spy = vi.spyOn(logger, "info").mockImplementation((() => {
      throw new Error("logging backend unavailable");
    }) as typeof logger.info);

    // Success path: the result is returned even though logging threw.
    const cleanSource = new FakeSource([changed(cleanSnapshotJson())]);
    const cleanProvider = new SnapshotProvider("snapshot", { source: cleanSource, config });
    const result = await cleanProvider.fetch(context());
    expect(result.readError).toBeNull();
    expect(cleanSource.accepted).toHaveLength(1);

    // Refusal path: the typed failure still propagates even though logging threw.
    const badSource = new FakeSource([changed("{ broken")]);
    const badProvider = new SnapshotProvider("snapshot", { source: badSource, config });
    await expectRefusal(badProvider.fetch(context()), "JSON_INVALID");

    // Exactly one logging attempt per fetch, each swallowed.
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

describe("SnapshotProvider.fetch — exhaustive refusal messages and safe output", () => {
  it("maps a source SOURCE_UNREADABLE failure to its exact canonical message", async () => {
    const source = new FakeSource([
      new SnapshotReadFailure("SOURCE_UNREADABLE", SNAPSHOT_READ_MESSAGES.SOURCE_UNREADABLE),
    ]);
    const provider = new SnapshotProvider("snapshot", { source, config });

    const failure = await expectRefusal(provider.fetch(context()), "SOURCE_UNREADABLE");
    expect(failure.message).toBe(SNAPSHOT_READ_MESSAGES.SOURCE_UNREADABLE);
  });

  it("maps an aborted signal to POLL_TIMEOUT", async () => {
    const controller = new AbortController();
    controller.abort();
    const source = new FakeSource([changed(cleanSnapshotJson())]);
    const provider = new SnapshotProvider("snapshot", { source, config });

    // The source maps the aborted signal to POLL_TIMEOUT; the canonical message
    // itself is asserted where the source produces it (snapshot-source.test.ts).
    await expectRefusal(provider.fetch({ signal: controller.signal }), "POLL_TIMEOUT");
    // An aborted read never accepts a revision.
    expect(source.accepted).toHaveLength(0);
  });

  it("preserves an unsupported protocol bounded variant from the source", async () => {
    const source = new FakeSource([
      new SnapshotReadFailure(
        "SOURCE_PROTOCOL_UNSUPPORTED",
        SNAPSHOT_READ_MESSAGES.SOURCE_PROTOCOL_UNSUPPORTED.replace("<protocol>", "ftp"),
      ),
    ]);
    const provider = new SnapshotProvider("snapshot", { source, config });

    const failure = await expectRefusal(provider.fetch(context()), "SOURCE_PROTOCOL_UNSUPPORTED");
    expect(failure.message).toBe(
      "Snapshot source protocol ftp is not supported; use a file path or HTTP(S) URL.",
    );
  });

  it("refuses malformed JSON, classification 2, and unsupported version with exact safe messages", async () => {
    const cases: Array<{ json: string; code: string; message: string }> = [
      { json: "{ not json", code: "JSON_INVALID", message: SNAPSHOT_READ_MESSAGES.JSON_INVALID },
      { json: JSON.stringify(42), code: "SNAPSHOT_INVALID", message: SNAPSHOT_READ_MESSAGES.SNAPSHOT_INVALID },
      {
        json: unsupportedVersionJson(),
        code: "VERSION_UNSUPPORTED",
        message: "Snapshot schemaVersion 999 is unsupported; supported version(s): 1.",
      },
    ];

    for (const testCase of cases) {
      const source = new FakeSource([changed(testCase.json)]);
      const provider = new SnapshotProvider("snapshot", { source, config });
      const failure = await expectRefusal(provider.fetch(context()), testCase.code);
      expect(failure.message).toBe(testCase.message);
      expect(source.accepted).toHaveLength(0);
    }
  });

  it("never leaks source, body, parser, or arbitrary text through errors or events", async () => {
    const { events } = captureReadEvents();
    const source = new FakeSource([
      new Error("FORBIDDEN_SENTINEL /secret/estate/snapshot.json body-excerpt-do-not-leak parser-position-42"),
    ]);
    const provider = new SnapshotProvider("snapshot", { source, config });

    const failure = await expectRefusal(provider.fetch(context()), "INTERNAL");

    const serializedError = `${failure.message} ${JSON.stringify(failure.toPublic())}`;
    const serializedEvents = JSON.stringify(events);
    for (const sentinel of FORBIDDEN_SENTINELS) {
      expect(serializedError).not.toContain(sentinel);
      expect(serializedEvents).not.toContain(sentinel);
    }
    // The public error carries no internal attempted-byte accounting.
    expect(failure.toPublic()).toEqual({ code: "INTERNAL", message: SNAPSHOT_READ_MESSAGES.INTERNAL });
  });
});
