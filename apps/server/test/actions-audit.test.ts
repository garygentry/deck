import { existsSync, mkdirSync, readFileSync, statSync, appendFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createAuditStore,
  type AuditEntry,
  type AuditListItem,
  type AuditDetail,
  type AuditTarget,
  type AuditStore,
  type AuditOutputSink,
  type AuditLogger,
} from "../src/actions/audit.js";
import { makeDataDir } from "./util/tmp-data.js";

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
  vi.restoreAllMocks();
});

/** Make a fresh tmp data dir + store, registering cleanup. */
function freshStore(logger?: AuditLogger): { dir: string; store: AuditStore } {
  const { dir, cleanup } = makeDataDir();
  cleanups.push(cleanup);
  return { dir, store: createAuditStore(dir, logger) };
}

let seq = 0;
function makeEntry(over: Partial<AuditEntry> = {}): AuditEntry {
  seq += 1;
  return {
    runId: `run-${seq}`,
    timestamp: new Date(2026, 0, 1, 0, 0, seq).toISOString(),
    actionId: "restart-svc",
    runner: "restart",
    params: { service: "nginx", force: true },
    source: "unknown",
    outcome: "succeeded",
    exitStatus: 0,
    durationMs: 12,
    outputBytes: 0,
    ...over,
  };
}

function rejectionEntry(runId: string): AuditEntry {
  return makeEntry({
    runId,
    outcome: "rejected",
    exitStatus: null,
    durationMs: 0,
    outputBytes: 0,
  });
}

describe("createAuditStore — exports & directory init", () => {
  it("exports a store with the AuditStore surface", () => {
    const { store } = freshStore();
    expect(typeof store.append).toBe("function");
    expect(typeof store.openOutput).toBe("function");
    expect(typeof store.list).toBe("function");
    expect(typeof store.read).toBe("function");
  });

  it("creates <dataDir>/actions/ and <dataDir>/actions/runs/ idempotently", () => {
    const { dir, cleanup } = makeDataDir();
    cleanups.push(cleanup);
    createAuditStore(dir);
    expect(statSync(join(dir, "actions")).isDirectory()).toBe(true);
    expect(statSync(join(dir, "actions", "runs")).isDirectory()).toBe(true);
    // Idempotent: a second create against the same dir does not throw.
    expect(() => createAuditStore(dir)).not.toThrow();
  });
});

describe("append — single-syscall atomic index write", () => {
  it("adds exactly one line per append", async () => {
    const { dir, store } = freshStore();
    await store.append(makeEntry({ runId: "a" }));
    await store.append(makeEntry({ runId: "b" }));
    const raw = readFileSync(join(dir, "actions", "audit.jsonl"), "utf8");
    const lines = raw.split("\n").filter((l) => l.trim() !== "");
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
  });

  it("does not use fs.appendFile (single O_APPEND write invariant)", () => {
    // REQ-CONC-01: the implementation must use openSync+writeSync+closeSync, never
    // fs.appendFile (which may split a buffer into multiple interleaving writes).
    const src = readFileSync(new URL("../src/actions/audit.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/appendFile/);
    expect(src).toMatch(/O_APPEND/);
    expect(src).toMatch(/writeSync/);
  });

  it("concurrent appends never interleave or corrupt (REQ-CONC-01)", async () => {
    const { dir, store } = freshStore();
    const count = 200;
    const entries = Array.from({ length: count }, (_, i) =>
      makeEntry({ runId: `c-${i}`, params: { i, blob: "x".repeat(64) } }),
    );
    await Promise.all(entries.map((e) => store.append(e)));

    const raw = readFileSync(join(dir, "actions", "audit.jsonl"), "utf8");
    const lines = raw.split("\n").filter((l) => l.trim() !== "");
    expect(lines).toHaveLength(count);
    const ids = new Set<string>();
    for (const line of lines) {
      const parsed = JSON.parse(line) as AuditEntry; // must parse cleanly
      ids.add(parsed.runId);
    }
    expect(ids.size).toBe(count);
  });
});

describe("openOutput + AuditOutputSink", () => {
  it("writes chunks to runs/<runId>.log and reports byte count on close", async () => {
    const { dir, store } = freshStore();
    const sink: AuditOutputSink = store.openOutput("run-out");
    const a = Buffer.from("hello ", "utf8");
    const b = Buffer.from("world\n", "utf8");
    await sink.write(a);
    await sink.write(b);
    const total = await sink.close();
    expect(total).toBe(a.byteLength + b.byteLength);

    const logPath = join(dir, "actions", "runs", "run-out.log");
    expect(readFileSync(logPath, "utf8")).toBe("hello world\n");
  });

  it("close is idempotent and returns the same byte count", async () => {
    const { store } = freshStore();
    const sink = store.openOutput("run-idem");
    await sink.write(Buffer.from("abc", "utf8"));
    const first = await sink.close();
    const second = await sink.close();
    expect(first).toBe(3);
    expect(second).toBe(3);
  });

  it("throws on write after close", async () => {
    const { store } = freshStore();
    const sink = store.openOutput("run-closed");
    await sink.close();
    await expect(sink.write(Buffer.from("x", "utf8"))).rejects.toThrow(
      /closed output sink/,
    );
  });
});

describe("pre-run rejection round-trip + list/read", () => {
  it("list is [] when the index does not exist", async () => {
    const { store } = freshStore();
    expect(await store.list()).toEqual([]);
  });

  it("read returns undefined for an unknown runId", async () => {
    const { store } = freshStore();
    expect(await store.read("nope")).toBeUndefined();
  });

  it("a rejection round-trips and read returns '' output", async () => {
    const { dir, store } = freshStore();
    const entry = rejectionEntry("rej-1");
    await store.append(entry);

    // No .log file was opened for the rejection.
    expect(existsSync(join(dir, "actions", "runs", "rej-1.log"))).toBe(false);

    const list = await store.list();
    expect(list).toHaveLength(1);
    const item: AuditListItem = list[0];
    expect(item.runId).toBe("rej-1");
    expect(item.outcome).toBe("rejected");
    expect(item.exitStatus).toBeNull();
    expect(item.durationMs).toBe(0);
    expect(item.outputBytes).toBe(0);
    expect("params" in item).toBe(false); // list projection omits params

    const detail: AuditDetail | undefined = await store.read("rej-1");
    expect(detail).toBeDefined();
    expect(detail?.output).toBe("");
    expect(detail?.entry.params).toEqual(entry.params);
  });

  it("list is newest-first (reverse append order)", async () => {
    const { store } = freshStore();
    await store.append(makeEntry({ runId: "first" }));
    await store.append(makeEntry({ runId: "second" }));
    await store.append(makeEntry({ runId: "third" }));
    const list = await store.list();
    expect(list.map((i) => i.runId)).toEqual(["third", "second", "first"]);
  });

  it("read joins the index entry with its captured .log output", async () => {
    const { store } = freshStore();
    const sink = store.openOutput("run-joined");
    await sink.write(Buffer.from("stream out\n", "utf8"));
    const bytes = await sink.close();
    await store.append(makeEntry({ runId: "run-joined", outputBytes: bytes }));

    const detail = await store.read("run-joined");
    expect(detail?.output).toBe("stream out\n");
    expect(detail?.entry.runId).toBe("run-joined");
  });

  it("preserves the target field through append/read", async () => {
    const { store } = freshStore();
    const target: AuditTarget = { host: "web01", service: "nginx" };
    await store.append(makeEntry({ runId: "with-target", target }));
    const detail = await store.read("with-target");
    expect(detail?.entry.target).toEqual(target);
  });

  it("a successful entry round-trips the complete AuditEntry field set, unredacted (universe guard)", async () => {
    const { store } = freshStore();
    const target: AuditTarget = { host: "web01", service: "nginx" };
    await store.append(
      makeEntry({
        runId: "full-entry",
        target,
        outcome: "succeeded",
        exitStatus: 0,
        durationMs: 55,
        outputBytes: 0,
      }),
    );
    const detail = await store.read("full-entry");
    expect(detail).toBeDefined();
    // No field silently dropped, none unexpectedly added: dropping e.g. `startedAt`
    // or `actionId` from the persisted entry would fail no other test in this file.
    expect(Object.keys(detail!.entry).sort()).toEqual(
      [
        "runId",
        "timestamp",
        "actionId",
        "runner",
        "params",
        "target",
        "source",
        "outcome",
        "exitStatus",
        "durationMs",
        "outputBytes",
      ].sort(),
    );
    // Unredacted — the value passed in comes back exactly, not masked/omitted.
    expect(detail!.entry.params).toEqual({ service: "nginx", force: true });
  });
});

describe("robust parsing of truncated / corrupt lines (REQ-OBS-01)", () => {
  it("drops a truncated final line without error and lists the rest", async () => {
    const { dir, store } = freshStore();
    await store.append(makeEntry({ runId: "ok-1" }));
    await store.append(makeEntry({ runId: "ok-2" }));
    // Simulate a crash mid-write: a truncated final line (no newline).
    appendFileSync(join(dir, "actions", "audit.jsonl"), '{"runId":"trunc","time');

    const list = await store.list();
    expect(list.map((i) => i.runId)).toEqual(["ok-2", "ok-1"]);
    // The good entries still read.
    expect((await store.read("ok-1"))?.entry.runId).toBe("ok-1");
  });

  it("skips a corrupt interior line, warns, and never throws", async () => {
    const logger: AuditLogger = { warn: vi.fn() };
    const { dir, store } = freshStore(logger);
    await store.append(makeEntry({ runId: "good-1" }));
    // Inject a corrupt interior line by writing garbage then a valid final line.
    appendFileSync(join(dir, "actions", "audit.jsonl"), "not-json-at-all\n");
    await store.append(makeEntry({ runId: "good-2" }));

    const list = await store.list();
    expect(list.map((i) => i.runId)).toEqual(["good-2", "good-1"]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ line: 1 }),
      expect.stringContaining("corrupt interior index line"),
    );
  });

  it("returns '' when the .log is missing even though outputBytes > 0", async () => {
    const { store } = freshStore();
    await store.append(makeEntry({ runId: "lost-log", outputBytes: 42 }));
    const detail = await store.read("lost-log");
    expect(detail?.output).toBe("");
    expect(detail?.entry.runId).toBe("lost-log");
  });

  it("a genuine fs error on the index throws rather than returning an empty result", async () => {
    const { dir, store } = freshStore();
    // A directory at the index path is not a parse error — it's a real I/O failure
    // (EISDIR) distinct from the ENOENT-tolerant "index does not exist yet" case
    // above. list()/read() must propagate it, never swallow it into [] / undefined.
    mkdirSync(join(dir, "actions", "audit.jsonl"));

    await expect(store.list()).rejects.toThrow();
    await expect(store.read("anything")).rejects.toThrow();
  });
});
