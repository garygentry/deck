import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ActionRunEvent } from "../../../modules/actions/server/types.js";

type RunStoreModule = typeof import("../../../modules/actions/web/run-store.js");
type ClientModule = typeof import("../../../modules/actions/web/client.js");

/**
 * The run store and client are module singletons. Each case loads a fresh module set
 * (vi.resetModules + dynamic import) so retained run state and the listener set are
 * isolated. run-store and client are imported from the same fresh graph so they share
 * the one singleton instance.
 */
interface Loaded {
  readonly store: RunStoreModule;
  readonly client: ClientModule;
}
async function load(): Promise<Loaded> {
  vi.resetModules();
  const store = (await import("../../../modules/actions/web/run-store.js")) as RunStoreModule;
  const client = (await import("../../../modules/actions/web/client.js")) as ClientModule;
  return { store, client };
}

/** Build a reader whose `read()` yields the given chunks in order, then done. */
function readerFromChunks(
  chunks: readonly Uint8Array[],
): ReadableStreamDefaultReader<Uint8Array> {
  let index = 0;
  return {
    read(): Promise<ReadableStreamReadResult<Uint8Array>> {
      if (index < chunks.length) {
        const value = chunks[index++];
        return Promise.resolve({ value, done: false });
      }
      return Promise.resolve({ value: undefined, done: true });
    },
    releaseLock(): void {},
    cancel(): Promise<void> {
      return Promise.resolve();
    },
    get closed(): Promise<undefined> {
      return Promise.resolve(undefined);
    },
  } as unknown as ReadableStreamDefaultReader<Uint8Array>;
}

const encoder = new TextEncoder();
function bytes(text: string): Uint8Array {
  return encoder.encode(text);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// readNdjsonEvents
// ---------------------------------------------------------------------------

describe("readNdjsonEvents", () => {
  it("dispatches run → stdout(×N) → end in order across split and multi-line chunks", async () => {
    const { client } = await load();
    // A line split across two reads, a chunk carrying two lines, and a final line
    // that arrives without a trailing newline.
    const chunks = [
      bytes('{"type":"run","ru'),
      bytes('nId":"r-1"}\n{"type":"stdout","data":"a"}\n'),
      bytes('{"type":"stdout","data":"b"}\n{"type":"stderr","data":"e"}\n'),
      bytes('{"type":"end","outcome":"succeeded","exit":0,"durationMs":12}'),
    ];
    const events: ActionRunEvent[] = [];
    await client.readNdjsonEvents(readerFromChunks(chunks), (e) => events.push(e));

    expect(events).toEqual([
      { type: "run", runId: "r-1" },
      { type: "stdout", data: "a" },
      { type: "stdout", data: "b" },
      { type: "stderr", data: "e" },
      { type: "end", outcome: "succeeded", exit: 0, durationMs: 12 },
    ]);
  });

  it("skips malformed lines and still flushes a trailing final line", async () => {
    const { client } = await load();
    const chunks = [
      bytes('{"type":"run","runId":"r-2"}\n'),
      bytes("not json at all\n"),
      bytes('{"type":"stdout","data":"ok"}\n'),
      bytes('{"type":"end","outcome":"failed","exit":3,"durationMs":5}'),
    ];
    const events: ActionRunEvent[] = [];
    await client.readNdjsonEvents(readerFromChunks(chunks), (e) => events.push(e));

    expect(events).toEqual([
      { type: "run", runId: "r-2" },
      { type: "stdout", data: "ok" },
      { type: "end", outcome: "failed", exit: 3, durationMs: 5 },
    ]);
  });

  it("ignores blank lines between events", async () => {
    const { client } = await load();
    const chunks = [bytes('\n\n{"type":"run","runId":"r-3"}\n\n')];
    const events: ActionRunEvent[] = [];
    await client.readNdjsonEvents(readerFromChunks(chunks), (e) => events.push(e));
    expect(events).toEqual([{ type: "run", runId: "r-3" }]);
  });
});

// ---------------------------------------------------------------------------
// run-store transitions via applyRunEvent
// ---------------------------------------------------------------------------

describe("run-store transitions", () => {
  it("moves idle → requesting → streaming → terminal, appending output", async () => {
    const { store } = await load();
    expect(store.getRunState()).toEqual({ status: "idle" });

    store.beginRun("deploy");
    expect(store.getRunState()).toEqual({ status: "requesting", actionId: "deploy" });

    store.applyRunEvent({ type: "run", runId: "run-1" });
    expect(store.getRunState()).toEqual({
      status: "streaming",
      actionId: "deploy",
      runId: "run-1",
      stdout: "",
      stderr: "",
    });

    store.applyRunEvent({ type: "stdout", data: "hello " });
    store.applyRunEvent({ type: "stdout", data: "world" });
    store.applyRunEvent({ type: "stderr", data: "warn" });
    expect(store.getRunState()).toMatchObject({
      status: "streaming",
      stdout: "hello world",
      stderr: "warn",
    });

    store.applyRunEvent({
      type: "end",
      outcome: "succeeded",
      exit: 0,
      durationMs: 42,
    });
    expect(store.getRunState()).toEqual({
      status: "terminal",
      actionId: "deploy",
      runId: "run-1",
      outcome: "succeeded",
      exit: 0,
      durationMs: 42,
      stdout: "hello world",
      stderr: "warn",
    });
  });

  it("replaces state atomically with a distinct frozen reference each publication", async () => {
    const { store } = await load();
    const idle = store.getRunState();
    store.beginRun("x");
    const requesting = store.getRunState();
    expect(requesting).not.toBe(idle);
    expect(Object.isFrozen(requesting)).toBe(true);
    store.applyRunEvent({ type: "run", runId: "r" });
    expect(store.getRunState()).not.toBe(requesting);
  });

  it("ignores out-of-order events without throwing", async () => {
    const { store } = await load();
    // stdout/end before any run event: ignored, still idle.
    expect(() =>
      store.applyRunEvent({ type: "stdout", data: "x" }),
    ).not.toThrow();
    expect(() =>
      store.applyRunEvent({ type: "end", outcome: "error", exit: null, durationMs: 0 }),
    ).not.toThrow();
    expect(store.getRunState()).toEqual({ status: "idle" });

    // An unknown event type is ignored defensively.
    expect(() =>
      store.applyRunEvent({ type: "bogus" } as unknown as ActionRunEvent),
    ).not.toThrow();
  });

  it("beginRun does not clobber an in-flight streaming run", async () => {
    const { store } = await load();
    store.beginRun("a");
    store.applyRunEvent({ type: "run", runId: "run-a" });
    store.beginRun("b");
    expect(store.getRunState()).toMatchObject({
      status: "streaming",
      actionId: "a",
      runId: "run-a",
    });
  });

  it("resetRun returns any state to idle", async () => {
    const { store } = await load();
    store.beginRun("a");
    store.applyRunEvent({ type: "run", runId: "run-a" });
    store.resetRun();
    expect(store.getRunState()).toBe(store.IDLE_RUN_STATE);
    expect(store.getRunState()).toEqual({ status: "idle" });
  });
});

// ---------------------------------------------------------------------------
// subscribeRunState — isolating notify + idempotent unsubscribe
// ---------------------------------------------------------------------------

describe("subscribeRunState", () => {
  it("notifies every subscriber on each publication", async () => {
    const { store } = await load();
    const a = vi.fn();
    const b = vi.fn();
    const unsubA = store.subscribeRunState(a);
    const unsubB = store.subscribeRunState(b);

    store.beginRun("x");
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);

    unsubA();
    unsubB();
  });

  it("iterates a copy of the listener set and swallows a throwing listener", async () => {
    const { store } = await load();
    const order: string[] = [];
    const throwing = vi.fn(() => {
      order.push("throwing");
      throw new Error("listener boom");
    });
    const healthy = vi.fn(() => {
      order.push("healthy");
    });
    store.subscribeRunState(throwing);
    store.subscribeRunState(healthy);

    expect(() => store.beginRun("x")).not.toThrow();
    // The healthy listener still ran despite the earlier throw.
    expect(healthy).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["throwing", "healthy"]);
  });

  it("allows a listener to unsubscribe during notify without skipping others (copy iteration)", async () => {
    const { store } = await load();
    const calls: string[] = [];
    let unsubSelf: () => void = () => {};
    const selfRemoving = vi.fn(() => {
      calls.push("self");
      unsubSelf();
    });
    const other = vi.fn(() => {
      calls.push("other");
    });
    unsubSelf = store.subscribeRunState(selfRemoving);
    store.subscribeRunState(other);

    expect(() => store.beginRun("x")).not.toThrow();
    expect(calls).toEqual(["self", "other"]);
  });

  it("returns an idempotent unsubscribe", async () => {
    const { store } = await load();
    const listener = vi.fn();
    const unsub = store.subscribeRunState(listener);

    store.beginRun("x");
    expect(listener).toHaveBeenCalledTimes(1);

    unsub();
    unsub(); // second call is a no-op, never throws
    store.applyRunEvent({ type: "run", runId: "r" });
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// invokeAction — drives the store, never throws to the caller
// ---------------------------------------------------------------------------

const ACTION = { id: "deploy", title: "Deploy", runner: "deploy-runner" } as unknown as Parameters<
  ClientModule["invokeAction"]
>[0];

describe("invokeAction", () => {
  it("streams a successful run: idle → requesting → streaming → terminal succeeded", async () => {
    const { store, client } = await load();
    const lines =
      '{"type":"run","runId":"run-9"}\n' +
      '{"type":"stdout","data":"working"}\n' +
      '{"type":"end","outcome":"succeeded","exit":0,"durationMs":7}\n';
    const response = {
      ok: true,
      body: { getReader: () => readerFromChunks([bytes(lines)]) },
    };
    vi.stubGlobal("fetch", vi.fn(async () => response as unknown as Response));

    await client.invokeAction(ACTION, {});

    expect(store.getRunState()).toEqual({
      status: "terminal",
      actionId: "deploy",
      runId: "run-9",
      outcome: "succeeded",
      exit: 0,
      durationMs: 7,
      stdout: "working",
      stderr: "",
    });
  });

  it("maps a non-2xx JSON error body to a terminal 'rejected' run with the refusal", async () => {
    const { store, client } = await load();
    const response = {
      ok: false,
      json: async () => ({
        error: "One or more parameters are invalid.",
        code: "PARAMS_INVALID",
        paramErrors: [{ name: "count", message: "must be a number" }],
      }),
    };
    vi.stubGlobal("fetch", vi.fn(async () => response as unknown as Response));

    await client.invokeAction(ACTION, { count: "abc" });

    const state = store.getRunState();
    expect(state).toMatchObject({
      status: "terminal",
      actionId: "deploy",
      runId: null,
      outcome: "rejected",
      refusal: {
        code: "PARAMS_INVALID",
        message: "One or more parameters are invalid.",
        paramErrors: [{ name: "count", message: "must be a number" }],
      },
    });
  });

  it("synthesizes a terminal 'error' when the reader throws mid-stream, never throwing to the caller", async () => {
    const { store, client } = await load();
    let reads = 0;
    const throwingReader = {
      read(): Promise<ReadableStreamReadResult<Uint8Array>> {
        reads += 1;
        if (reads === 1) {
          return Promise.resolve({ value: bytes('{"type":"run","runId":"run-x"}\n'), done: false });
        }
        return Promise.reject(new Error("stream dropped"));
      },
      releaseLock(): void {},
      cancel(): Promise<void> {
        return Promise.resolve();
      },
    } as unknown as ReadableStreamDefaultReader<Uint8Array>;
    const response = { ok: true, body: { getReader: () => throwingReader } };
    vi.stubGlobal("fetch", vi.fn(async () => response as unknown as Response));

    await expect(client.invokeAction(ACTION, {})).resolves.toBeUndefined();

    expect(store.getRunState()).toMatchObject({
      status: "terminal",
      actionId: "deploy",
      runId: "run-x",
      outcome: "error",
      refusal: { code: "REQUEST" },
    });
  });

  it("maps a 2xx response with a null body to a terminal 'error'", async () => {
    const { store, client } = await load();
    const response = { ok: true, body: null };
    vi.stubGlobal("fetch", vi.fn(async () => response as unknown as Response));

    await client.invokeAction(ACTION, {});

    expect(store.getRunState()).toMatchObject({
      status: "terminal",
      outcome: "error",
      refusal: { code: "REQUEST" },
    });
  });

  it("maps a fetch rejection (no response) to a terminal 'error'", async () => {
    const { store, client } = await load();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );

    await expect(client.invokeAction(ACTION, {})).resolves.toBeUndefined();
    expect(store.getRunState()).toMatchObject({
      status: "terminal",
      outcome: "error",
      refusal: { code: "REQUEST" },
    });
  });
});

// ---------------------------------------------------------------------------
// cancelRun / audit reads
// ---------------------------------------------------------------------------

describe("cancelRun", () => {
  it("returns true on 202 and false on 404", async () => {
    const { client } = await load();
    vi.stubGlobal("fetch", vi.fn(async () => ({ status: 202 }) as unknown as Response));
    expect(await client.cancelRun("run-1")).toBe(true);

    vi.stubGlobal("fetch", vi.fn(async () => ({ status: 404 }) as unknown as Response));
    expect(await client.cancelRun("run-1")).toBe(false);
  });
});

describe("fetchAudit / fetchAuditDetail", () => {
  it("fetchAudit returns the parsed list", async () => {
    const { client } = await load();
    const items = [{ runId: "r-1" }];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => items }) as unknown as Response),
    );
    expect(await client.fetchAudit()).toEqual(items);
  });

  it("fetchAuditDetail returns undefined on 404 and the entry otherwise", async () => {
    const { client } = await load();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ status: 404, ok: false }) as unknown as Response),
    );
    expect(await client.fetchAuditDetail("nope")).toBeUndefined();

    const detail = { entry: { runId: "r-1" }, output: "hi" };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ status: 200, ok: true, json: async () => detail }) as unknown as Response),
    );
    expect(await client.fetchAuditDetail("r-1")).toEqual(detail);
  });
});

// ---------------------------------------------------------------------------
// endpoint construction
// ---------------------------------------------------------------------------

describe("ACTION_ENDPOINTS", () => {
  it("encodes ids and run ids in the URLs", async () => {
    const { client } = await load();
    expect(client.ACTION_ENDPOINTS.invoke("a b/c")).toBe("/api/actions/a%20b%2Fc");
    expect(client.ACTION_ENDPOINTS.cancel("r/1")).toBe(
      "/api/actions/runs/r%2F1/cancel",
    );
    expect(client.ACTION_ENDPOINTS.audit).toBe("/api/actions/audit");
    expect(client.ACTION_ENDPOINTS.auditDetail("r/1")).toBe(
      "/api/actions/audit/r%2F1",
    );
  });
});

beforeEach(() => {
  // Fresh module graph per test is handled by load(); nothing else to reset here.
});
