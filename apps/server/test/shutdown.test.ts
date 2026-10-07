/**
 * Signal handling: SIGTERM (`docker stop`) and SIGINT run the boot handle's stop() (module
 * onStop hooks included) and then exit. Unit-tested over a fake signal source, then end to
 * end against a real `bun src/server/boot.ts` process.
 */

import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { createServer, type AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { DEFAULT_KILL_GRACE_MS, DEFAULT_PUMP_DRAIN_MS } from "../src/actions/executor.js";
import { ACTIONS_STOP_TIMEOUT_MS } from "../src/actions/module.js";
import { DEFAULT_SHUTDOWN_DEADLINE_MS, installShutdown } from "../src/server/shutdown.js";
import { DEFAULT_STOP_TIMINGS, resolveStopTimings, SHUTDOWN_MARGIN_MS, stopBudgetMs } from "../src/server/stop-timings.js";

function setup(stop: () => Promise<void>, deadlineMs = 60_000) {
  const proc = new EventEmitter();
  const exit = vi.fn();
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  installShutdown({ stop }, { proc, exit, logger: logger as never, deadlineMs });
  return { proc, exit, logger };
}

describe("shutdown stage bounds (review N3)", () => {
  it("fit inside the shutdown deadline with margin, so a stop using every bound still exits cleanly", () => {
    expect(stopBudgetMs(DEFAULT_STOP_TIMINGS) + SHUTDOWN_MARGIN_MS).toBeLessThanOrEqual(DEFAULT_SHUTDOWN_DEADLINE_MS);
    expect(SHUTDOWN_MARGIN_MS).toBeGreaterThanOrEqual(1_000);
  });

  it("give a cancelled action run time to escalate to SIGKILL and drain before the stage ends", () => {
    // The actions module's early stop hook carries its own bound, inside the module stage.
    expect(2 * DEFAULT_KILL_GRACE_MS + DEFAULT_PUMP_DRAIN_MS).toBeLessThan(ACTIONS_STOP_TIMEOUT_MS);
    expect(ACTIONS_STOP_TIMEOUT_MS).toBeLessThanOrEqual(DEFAULT_STOP_TIMINGS.modulesMs);
  });

  it("keep one module's drain and a hook inside the module stage", () => {
    expect(DEFAULT_STOP_TIMINGS.drainTimeoutMs + DEFAULT_STOP_TIMINGS.hookTimeoutMs).toBeLessThan(DEFAULT_STOP_TIMINGS.modulesMs);
  });

  it("apply only the overrides given", () => {
    expect(resolveStopTimings({ graceMs: 10, hookTimeoutMs: undefined })).toEqual({ ...DEFAULT_STOP_TIMINGS, graceMs: 10 });
  });
});

describe("installShutdown", () => {
  it.each(["SIGTERM", "SIGINT"] as const)("%s stops the handle, then exits 0", async (signal) => {
    let release!: () => void;
    const stop = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const { proc, exit, logger } = setup(stop);
    proc.emit(signal);
    expect(stop).toHaveBeenCalledOnce();
    expect(exit).not.toHaveBeenCalled();
    release();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(logger.info).toHaveBeenCalledWith({ event: "server.stop", signal, phase: "stopping" }, "stopping");
    expect(logger.info).toHaveBeenCalledWith({ event: "server.stop", signal, phase: "stopped" }, "stopped");
  });

  it("exits 1 when stopping fails", async () => {
    const { proc, exit, logger } = setup(async () => { throw new Error("boom"); });
    proc.emit("SIGTERM");
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
    expect(logger.error).toHaveBeenCalledWith({ event: "server.stop", signal: "SIGTERM", phase: "failed", error: "Error: boom" }, "stop failed");
  });

  it("exits 1 at the deadline when stopping never settles, and only once", async () => {
    vi.useFakeTimers();
    try {
      const { proc, exit, logger } = setup(() => new Promise<void>(() => {}), 1_000);
      proc.emit("SIGTERM");
      await vi.advanceTimersByTimeAsync(999);
      expect(exit).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(exit.mock.calls).toEqual([[1]]);
      expect(logger.error).toHaveBeenCalledWith({ event: "server.stop", signal: "SIGTERM", phase: "deadline", deadlineMs: 1_000 }, "shutdown deadline passed; exiting");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a second signal while stopping exits 1 at once, without stopping again", () => {
    const stop = vi.fn(() => new Promise<void>(() => {}));
    const { proc, exit } = setup(stop);
    proc.emit("SIGTERM");
    proc.emit("SIGINT");
    expect(stop).toHaveBeenCalledOnce();
    expect(exit.mock.calls).toEqual([[1]]);
  });
});

const hasBun = spawnSync("bun", ["--version"]).status === 0;

/** A port the OS reports free on loopback (deck's DECK_PORT cannot be 0). */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

interface Deck {
  port: number;
  events(): Record<string, unknown>[];
  /** Resolves with the exit code and the ms from `signalledAt` to exit. */
  exited: Promise<{ code: number | null; afterSignalMs: number }>;
  signal(): void;
  waitFor(event: string): Promise<void>;
}

/** Spawn a deck process (`entry`: the real server, or the probe fixture) on a free port. */
async function spawnDeck(entry: string, env: Record<string, string>, config: string): Promise<Deck> {
  const dir = mkdtempSync(join(tmpdir(), "deck-shutdown-"));
  writeFileSync(join(dir, "00-base.yaml"), "schemaVersion: 2\nestate:\n  name: shutdown\n");
  if (config) writeFileSync(join(dir, "10-overlay.yaml"), config);
  const port = await freePort();
  const child = spawn("bun", [fileURLToPath(new URL(entry, import.meta.url))], {
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", DECK_CONFIG_DIR: dir, DECK_PORT: String(port), DECK_LOG_LEVEL: "info", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  let signalledAt = 0;
  const exited = new Promise<{ code: number | null; afterSignalMs: number }>((resolve) => child.on("exit", (code) => {
    rmSync(dir, { recursive: true, force: true });
    resolve({ code, afterSignalMs: Date.now() - signalledAt });
  }));
  const events = () => output.split("\n").filter((line) => line.startsWith("{")).map((line) => JSON.parse(line) as Record<string, unknown>);
  return {
    port,
    events,
    exited,
    signal: () => {
      signalledAt = Date.now();
      child.kill("SIGTERM");
    },
    waitFor: (event) => vi.waitFor(() => expect(events().map((e) => e.event)).toContain(event), { timeout: 20_000, interval: 50 }),
  };
}

const FIXTURE = "./fixtures/shutdown/entry.ts";
const probeEnv = (scenario: string, extra: Record<string, string> = {}) => ({ SHUTDOWN_SCENARIO: scenario, ...extra });

describe.skipIf(!hasBun)("deck process shutdown", () => {
  it("SIGTERM runs module stop hooks and exits 0", async () => {
    const deck = await spawnDeck("../src/server/boot.ts", {}, "schemaVersion: 2\nmodules:\n  llm-usage:\n    thresholds:\n      warn: 70\n");
    await deck.waitFor("server.start");
    deck.signal();
    expect((await deck.exited).code).toBe(0);
    expect(deck.events()).toContainEqual(expect.objectContaining({ event: "module.stop", module: "llm-usage" }));
    expect(deck.events()).toContainEqual(expect.objectContaining({ event: "server.stop", signal: "SIGTERM", phase: "stopped" }));
  }, 30_000);

  it("SIGTERM cancels an action run whose grandchild holds the pipe, audits it as cancelled, then exits 0 (review N1)", async () => {
    const data = mkdtempSync(join(tmpdir(), "deck-shutdown-actions-"));
    try {
      const runner = fileURLToPath(new URL("./fixtures/actions-runners/grandchild-runner.sh", import.meta.url));
      writeFileSync(join(data, "runners.json"), JSON.stringify({ grandchild: runner }));
      const deck = await spawnDeck("../src/server/boot.ts", {
        DECK_ACTIONS_ENABLED: "true",
        DECK_DATA_DIR: join(data, "data"),
        DECK_RUNNERS_FILE: join(data, "runners.json"),
      }, "schemaVersion: 2\nmodules:\n  actions:\n    actions:\n      - id: hold\n        title: Hold\n        runner: grandchild\n        confirm: none\n        description: Holds its output pipe open.\n");
      await deck.waitFor("server.start");
      // The client stays attached, reading the run's NDJSON stream.
      const response = await fetch(`http://127.0.0.1:${deck.port}/api/actions/hold`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      const reader = response.body!.getReader();
      let stream = "";
      while (!/grandchild (\d+)/.test(stream)) stream += new TextDecoder().decode((await reader.read()).value);
      const grandchild = Number(/grandchild (\d+)/.exec(stream)![1]);
      const runId = (JSON.parse(stream.split("\n")[0]!) as { runId: string }).runId;
      const rest = (async () => {
        for (;;) {
          const step = await reader.read().catch(() => ({ done: true, value: undefined }));
          if (step.done) return stream;
          stream += new TextDecoder().decode(step.value);
        }
      })();

      deck.signal();
      const { code, afterSignalMs } = await deck.exited;
      expect(code).toBe(0);
      expect(afterSignalMs).toBeLessThan(6_000);
      const index = readFileSync(join(data, "data/actions/audit.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(index).toContainEqual(expect.objectContaining({ runId, actionId: "hold", outcome: "cancelled" }));
      expect(await rest).toContain('"outcome":"cancelled"');
      // The process group was killed: the grandchild is gone too.
      expect(() => process.kill(grandchild, 0)).toThrow();
    } finally {
      rmSync(data, { recursive: true, force: true });
    }
  }, 30_000);

  it("a hung stop hook is abandoned at its bound; the listener closed first, so no request lands meanwhile", async () => {
    const deck = await spawnDeck(FIXTURE, probeEnv("hung-hook"), "");
    await deck.waitFor("server.start");
    expect(await (await fetch(`http://127.0.0.1:${deck.port}/api/m/probe/ping`)).text()).toBe("pong");
    deck.signal();
    await deck.waitFor("server.stop");
    // The hook hangs for its 1s bound. Nothing new reaches the app meanwhile: a fresh
    // connection is refused (the listener closed first), and a request on the kept-alive
    // connection from the ping above gets a 503.
    const late = await fetch(`http://127.0.0.1:${deck.port}/api/m/probe/ping`).then((r) => r.status, () => "refused");
    expect([503, "refused"]).toContain(late);
    const { code, afterSignalMs } = await deck.exited;
    expect(code).toBe(0);
    expect(afterSignalMs).toBeLessThan(4_000);
    expect(deck.events()).toContainEqual(expect.objectContaining({ event: "probe.stop-hook-timeout", hookTimeoutMs: 1_000 }));
    expect(deck.events()).toContainEqual(expect.objectContaining({ event: "server.stop", phase: "stopped" }));
  }, 30_000);

  it("a request held open across SIGTERM gets the grace period, then its connection is closed", async () => {
    const deck = await spawnDeck(FIXTURE, probeEnv("held"), "");
    await deck.waitFor("server.start");
    const response = await fetch(`http://127.0.0.1:${deck.port}/api/m/probe/hold`);
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("held\n");
    const rest = reader.read().then((step) => (step.done ? "ended" : "data"), () => "closed");
    deck.signal();
    const { code, afterSignalMs } = await deck.exited;
    expect(code).toBe(0);
    expect(afterSignalMs).toBeLessThan(4_000);
    expect(["ended", "closed"]).toContain(await rest);
    expect(deck.events()).toContainEqual(expect.objectContaining({ event: "server.stop-forced", graceMs: 500 }));
  }, 30_000);

  it("a signal during a boot that never finishes exits 1 at the shutdown deadline", async () => {
    const deck = await spawnDeck(FIXTURE, probeEnv("hung-init", { SHUTDOWN_DEADLINE_MS: "1500" }), "");
    await deck.waitFor("probe.init-started");
    deck.signal();
    const { code, afterSignalMs } = await deck.exited;
    expect(code).toBe(1);
    expect(afterSignalMs).toBeGreaterThanOrEqual(1_400);
    expect(afterSignalMs).toBeLessThan(4_000);
    expect(deck.events()).toContainEqual(expect.objectContaining({ event: "server.stop", phase: "deadline", deadlineMs: 1_500 }));
  }, 30_000);

  it("a signal during a slow boot waits for it, then stops cleanly", async () => {
    const deck = await spawnDeck(FIXTURE, probeEnv("slow-init"), "");
    await deck.waitFor("probe.init-started");
    deck.signal();
    expect((await deck.exited).code).toBe(0);
    const order = deck.events().map((event) => event.event);
    expect(order.indexOf("server.start")).toBeLessThan(order.lastIndexOf("server.stop"));
    expect(deck.events()).toContainEqual(expect.objectContaining({ event: "module.stop", module: "probe" }));
  }, 30_000);
});
