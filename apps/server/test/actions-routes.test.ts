import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Hono } from "hono";
import type { Logger } from "pino";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";

import { createActionExecutor, type ActionExecutor } from "../src/actions/executor.js";
import { createAuditStore, type AuditStore } from "../src/actions/audit.js";
import { registerActionRoutes } from "../src/actions/route.js";
import type { Action } from "../src/actions/config.generated.js";
import type { ActionsDeps, ActionsRuntime } from "../src/actions/runtime.js";
import { createApp, type AppDeps, type ProviderReader } from "../src/server/app.js";
import type { DeckConfig } from "../src/contract/index.js";
import { actionsApp } from "./util/actions-module.js";
import { createFakeSpawner, type FakeSpawner, type FakeSpawnerScript } from "./util/fake-spawner.js";
import { makeDataDir } from "./util/tmp-data.js";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures/actions-estate");

function loadConfig(): DeckConfig {
  return JSON.parse(readFileSync(join(fixturesDir, "config.json"), "utf8")) as DeckConfig;
}

function loadRunnersMap(): ReadonlyMap<string, string> {
  const raw = JSON.parse(readFileSync(join(fixturesDir, "runners.json"), "utf8")) as Record<
    string,
    string
  >;
  return new Map(Object.entries(raw));
}

const enc = (s: string) => new TextEncoder().encode(s);

function fakeLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
}

const noProviders: ProviderReader = {
  read: () => undefined,
  count: () => 0,
  listHealth: () => ({}),
  listProviders: () => [],
  setProjections: () => {},
};

interface Harness {
  app: ReturnType<typeof createApp>;
  audit: AuditStore;
  spawner: FakeSpawner;
  cancelSpy: Mock<[runId: string], boolean>;
  cleanups: (() => void)[];
}

interface HarnessOptions {
  timeoutMs?: number;
  scripts?: FakeSpawnerScript | FakeSpawnerScript[];
}

function makeHarness(options: HarnessOptions = {}): Harness {
  const cleanups: (() => void)[] = [];
  const { dir, cleanup } = makeDataDir();
  cleanups.push(cleanup);

  const spawner = createFakeSpawner(options.scripts ?? { stdout: [enc("ok\n")], exitCode: 0 });
  const audit = createAuditStore(dir);
  const executor: ActionExecutor = createActionExecutor({
    spawner,
    audit,
    timeoutMs: options.timeoutMs ?? 600_000,
    logger: fakeLogger(),
  });
  // Spy on cancel so the disconnect test can assert it is never called by the route.
  const cancelSpy = vi.fn((runId: string) => executor.cancel(runId));
  const spiedExecutor: ActionExecutor = {
    start: (invocation) => executor.start(invocation),
    cancel: cancelSpy,
    cancelAll: () => executor.cancelAll(),
  };

  const runtime: ActionsRuntime = {
    timeoutMs: options.timeoutMs ?? 600_000,
    runners: loadRunnersMap(),
  };
  const actions: ActionsDeps = { runtime, executor: spiedExecutor, audit };

  const config = loadConfig();
  const deps: AppDeps = { config, providers: noProviders, logger: fakeLogger() };
  // The routes as the module host mounts them: the module's sub-app at the legacy prefix.
  const routes = new Hono();
  registerActionRoutes(routes, {
    declared: () => (config.modules as { actions?: { actions?: Action[] } }).actions?.actions ?? [],
    logger: fakeLogger(),
    actions,
  });
  const app = createApp(deps);
  app.route("/api/actions", routes);

  return { app, audit, spawner, cancelSpy, cleanups };
}

async function readLines(response: Response): Promise<Record<string, unknown>[]> {
  const text = await response.text();
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function waitFor<T>(fn: () => Promise<T | undefined>, timeoutMs = 2000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("waitFor: condition not met in time");
    await new Promise((r) => setTimeout(r, 5));
  }
}

const activeHarnesses: Harness[] = [];
function harness(options: HarnessOptions = {}): Harness {
  const h = makeHarness(options);
  activeHarnesses.push(h);
  return h;
}

afterEach(() => {
  while (activeHarnesses.length > 0) {
    const h = activeHarnesses.pop()!;
    for (const c of h.cleanups) c();
  }
  vi.restoreAllMocks();
});

describe("registerActionRoutes — route surface", () => {
  it("registers exactly the five routes: two POST (run + cancel), three GET (capability + audit)", () => {
    const app = new Hono();
    const before = app.routes.length;
    registerActionRoutes(app, { declared: () => [], logger: fakeLogger(), actions: {} as ActionsDeps });
    const added = app.routes.slice(before);
    const posts = added.filter((r) => r.method === "POST");
    const gets = added.filter((r) => r.method === "GET");

    // Relative to the module's prefix (`/api/m/actions`, and the legacy `/api/actions`).
    expect(posts.map((r) => r.path).sort()).toEqual(["/:id", "/runs/:runId/cancel"].sort());
    expect(gets.map((r) => r.path).sort()).toEqual(["/", "/audit", "/audit/:runId"].sort());
    // No other methods (PUT/DELETE/PATCH) and no extra routes added.
    expect(added.length).toBe(5);
  });

  it("the mounted action routes answer a POST run (not the SPA fallback)", async () => {
    const { app } = harness();
    const response = await app.request("/api/actions/restart-quiet", { method: "POST" });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/x-ndjson");
  });

  it("GET /api/actions reports the capability as enabled with HTTP 200 (no 403)", async () => {
    const { app } = harness();
    const response = await app.request("/api/actions");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ enabled: true });
  });

  it("GET /api/actions reports disabled with HTTP 200 when the capability is off", async () => {
    const { app } = await actionsApp();
    const response = await app.request("/api/actions");
    // 200 (not 403) is the whole point: the web reads this to skip the audit poll.
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ enabled: false });
  });
});

describe("POST /api/actions/:id — happy path streaming", () => {
  it("streams NDJSON: run first, end last, with multiple stdout events", async () => {
    const { app } = harness({
      scripts: {
        stdout: [enc("line one\n"), enc("line two\n"), enc("line three\n")],
        exitCode: 0,
        chunkDelayMs: 1,
      },
    });
    const response = await app.request("/api/actions/restart-quiet", { method: "POST" });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/x-ndjson");

    const events = await readLines(response);
    expect(events[0]).toMatchObject({ type: "run" });
    expect(typeof events[0].runId).toBe("string");

    const stdout = events.filter((e) => e.type === "stdout");
    expect(stdout.length).toBeGreaterThanOrEqual(2); // incremental delivery

    const last = events[events.length - 1];
    expect(last).toMatchObject({ type: "end", outcome: "succeeded", exit: 0 });
    expect(typeof last.durationMs).toBe("number");
  });

  it("passes validated params as stdin JSON and records the source header", async () => {
    const { app, spawner, audit } = harness({ scripts: { stdout: [enc("done\n")], exitCode: 0 } });
    const response = await app.request("/api/actions/deploy", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.7, 10.0.0.1" },
      body: JSON.stringify({ name: "web", count: "3", mode: "fast" }),
    });
    const events = await readLines(response);
    expect(events[events.length - 1]).toMatchObject({ type: "end", outcome: "succeeded" });

    expect(spawner.calls).toHaveLength(1);
    const stdin = JSON.parse(spawner.calls[0].stdinJson) as {
      actionId: string;
      params: Record<string, unknown>;
    };
    expect(stdin.actionId).toBe("deploy");
    // number/enum coerced; boolean default applied.
    expect(stdin.params).toEqual({ name: "web", count: 3, verbose: false, mode: "fast" });

    const runId = events[0].runId as string;
    const detail = await waitFor(async () => audit.read(runId));
    expect(detail.entry.source).toBe("203.0.113.7"); // X-Forwarded-For first hop
    expect(detail.entry.runner).toBe("echo-runner");
  });
});

describe("POST /api/actions/:id — pre-run gates", () => {
  it("gate 1: capability off (the module is not running) → 403 and no store to write", async () => {
    const spawner = createFakeSpawner({});
    const { app } = await actionsApp({ createSpawner: () => spawner });
    const response = await app.request("/api/actions/restart-quiet", { method: "POST" });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "ACTIONS_DISABLED" });
    expect(spawner.calls).toHaveLength(0);
  });

  it("gate 2: undeclared id → 404 ACTION_UNKNOWN + rejected", async () => {
    const { app, audit, spawner } = harness();
    const response = await app.request("/api/actions/nope", { method: "POST" });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "ACTION_UNKNOWN" });
    expect(spawner.calls).toHaveLength(0);
    const list = await audit.list();
    expect(list[0]).toMatchObject({ outcome: "rejected", actionId: "nope" });
  });

  it("gate 3: unknown runner → 422 RUNNER_UNRESOLVED + rejected", async () => {
    const { app, audit, spawner } = harness();
    const response = await app.request("/api/actions/orphan", { method: "POST" });
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ code: "RUNNER_UNRESOLVED" });
    expect(spawner.calls).toHaveLength(0);
    const list = await audit.list();
    expect(list[0]).toMatchObject({ outcome: "rejected", runner: "missing-runner" });
  });

  it("gate 4: invalid params → 400 PARAMS_INVALID with paramErrors + rejected, no spawn", async () => {
    const { app, audit, spawner } = harness();
    const response = await app.request("/api/actions/deploy", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ count: "not-a-number" }), // missing required name + bad number
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { code: string; paramErrors: unknown[] };
    expect(body.code).toBe("PARAMS_INVALID");
    expect(Array.isArray(body.paramErrors)).toBe(true);
    expect(body.paramErrors.length).toBeGreaterThan(0);
    expect(spawner.calls).toHaveLength(0);
    const list = await audit.list();
    expect(list[0].outcome).toBe("rejected");
  });

  it("gate 4: malformed JSON body → 400 PARAMS_INVALID + rejected, no spawn", async () => {
    const { app, audit, spawner } = harness();
    const response = await app.request("/api/actions/restart-quiet", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{ this is not json",
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { code: string; paramErrors: { name: string; message: string }[] };
    expect(body.code).toBe("PARAMS_INVALID");
    expect(body.paramErrors[0].message).toMatch(/not valid json/i);
    expect(spawner.calls).toHaveLength(0);
    expect((await audit.list())[0].outcome).toBe("rejected");
  });
});

describe("POST /api/actions/:id — runtime outcomes", () => {
  it("non-zero exit → end outcome 'failed' with the exit code", async () => {
    const { app } = harness({ scripts: { stdout: [enc("boom\n")], exitCode: 3 } });
    const events = await readLines(await app.request("/api/actions/restart-quiet", { method: "POST" }));
    expect(events[events.length - 1]).toMatchObject({ type: "end", outcome: "failed", exit: 3 });
  });

  it("spawn throw → end outcome 'error'", async () => {
    const { app } = harness({ scripts: { throwOnSpawn: new Error("ENOENT: no such runner") } });
    const events = await readLines(await app.request("/api/actions/restart-quiet", { method: "POST" }));
    expect(events[events.length - 1]).toMatchObject({ type: "end", outcome: "error", exit: null });
  });

  it("timeout → end outcome 'timed-out'", async () => {
    const { app } = harness({ timeoutMs: 5, scripts: { hang: true } });
    const events = await readLines(await app.request("/api/actions/restart-quiet", { method: "POST" }));
    expect(events[events.length - 1]).toMatchObject({ type: "end", outcome: "timed-out", exit: null });
  });
});

describe("POST /api/actions/:id — client disconnect (REQ-STREAM-03)", () => {
  it("disconnect does not call executor.cancel; the run completes with a .log + audit entry", async () => {
    const { app, audit, cancelSpy } = harness({
      scripts: { stdout: [enc("chunk-a\n"), enc("chunk-b\n")], exitCode: 0, chunkDelayMs: 20 },
    });
    const response = await app.request("/api/actions/restart-quiet", { method: "POST" });
    const reader = response.body!.getReader();

    // Read the first chunk (at least the run event), then abandon the reader (disconnect).
    const first = await reader.read();
    expect(first.done).toBe(false);
    const runId = (JSON.parse(new TextDecoder().decode(first.value).split("\n")[0]) as { runId: string })
      .runId;
    await reader.cancel();

    // Executor keeps running server-side: the audit entry + output land regardless.
    const detail = await waitFor(async () => audit.read(runId));
    expect(detail.entry.outcome).toBe("succeeded");
    expect(detail.output).toContain("chunk-a");
    expect(detail.output).toContain("chunk-b");
    // A disconnect is NOT a cancel.
    expect(cancelSpy).not.toHaveBeenCalled();
  });
});

describe("POST /api/actions/runs/:runId/cancel", () => {
  it("202 for a live run (outcome cancelled) and 404 for an unknown/finished id", async () => {
    const { app } = harness({ scripts: { hang: true } });
    const response = await app.request("/api/actions/restart-quiet", { method: "POST" });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    const pump = async (): Promise<void> => {
      const chunk = await reader.read();
      if (chunk.value) buffered += decoder.decode(chunk.value, { stream: true });
    };
    await pump(); // first chunk carries the run event
    const runId = (JSON.parse(buffered.split("\n")[0]) as { runId: string }).runId;

    const cancel = await app.request(`/api/actions/runs/${runId}/cancel`, { method: "POST" });
    expect(cancel.status).toBe(202);

    // Drain the rest of the stream; it terminates with a cancelled end event.
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffered += decoder.decode(chunk.value, { stream: true });
    }
    const events = buffered
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(events[events.length - 1]).toMatchObject({ type: "end", outcome: "cancelled" });

    // A second cancel for the now-finished run → 404 RUN_NOT_FOUND.
    const again = await app.request(`/api/actions/runs/${runId}/cancel`, { method: "POST" });
    expect(again.status).toBe(404);
    expect(await again.json()).toMatchObject({ code: "RUN_NOT_FOUND" });
  });

  it("cancel is refused 403 when the capability is disabled", async () => {
    const { app } = await actionsApp();
    const response = await app.request("/api/actions/runs/whatever/cancel", { method: "POST" });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "ACTIONS_DISABLED" });
  });
});

describe("GET /api/actions/audit + /api/actions/audit/:runId", () => {
  it("returns newest-first list and a per-run detail; 404 for unknown runId", async () => {
    const { app } = harness({ scripts: { stdout: [enc("hi\n")], exitCode: 0 } });

    // First run.
    const r1 = await readLines(await app.request("/api/actions/restart-quiet", { method: "POST" }));
    const runId1 = r1[0].runId as string;
    // Second run.
    const r2 = await readLines(await app.request("/api/actions/restart-quiet", { method: "POST" }));
    const runId2 = r2[0].runId as string;

    const list = await waitFor(async () => {
      const response = await app.request("/api/actions/audit");
      const items = (await response.json()) as { runId: string }[];
      return items.length >= 2 ? items : undefined;
    });
    // Newest-first: the second run appears before the first.
    const idx1 = list.findIndex((i) => i.runId === runId1);
    const idx2 = list.findIndex((i) => i.runId === runId2);
    expect(idx2).toBeLessThan(idx1);

    const detail = await app.request(`/api/actions/audit/${runId1}`);
    expect(detail.status).toBe(200);
    expect((await detail.json()) as { entry: { runId: string } }).toMatchObject({
      entry: { runId: runId1 },
    });

    const missing = await app.request("/api/actions/audit/does-not-exist");
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ code: "AUDIT_NOT_FOUND" });
  });

  it("audit reads are refused 403 when the capability is off", async () => {
    const { app } = await actionsApp();
    const list = await app.request("/api/actions/audit");
    expect(list.status).toBe(403);
    const detail = await app.request("/api/actions/audit/whatever");
    expect(detail.status).toBe(403);
  });
});

describe("deriveSource precedence (REQ-AUDIT-02)", () => {
  it("falls back X-Forwarded-For → X-Real-IP → 'unknown' in the audit entry", async () => {
    // X-Real-IP used when no X-Forwarded-For.
    const h1 = harness({ scripts: { stdout: [enc("x\n")], exitCode: 0 } });
    const e1 = await readLines(
      await h1.app.request("/api/actions/restart-quiet", {
        method: "POST",
        headers: { "x-real-ip": "198.51.100.9" },
      }),
    );
    const d1 = await waitFor(async () => h1.audit.read(e1[0].runId as string));
    expect(d1.entry.source).toBe("198.51.100.9");

    // Neither header → "unknown".
    const h2 = harness({ scripts: { stdout: [enc("x\n")], exitCode: 0 } });
    const e2 = await readLines(await h2.app.request("/api/actions/restart-quiet", { method: "POST" }));
    const d2 = await waitFor(async () => h2.audit.read(e2[0].runId as string));
    expect(d2.entry.source).toBe("unknown");
  });
});

describe("security posture (REQ-SEC-01/02)", () => {
  it("no route challenges an unauthenticated request", async () => {
    const { app } = harness();
    const responses = await Promise.all([
      app.request("/api/actions/restart-quiet", { method: "POST" }),
      app.request("/api/actions/runs/whatever/cancel", { method: "POST" }),
      app.request("/api/actions/audit"),
      app.request("/api/actions/audit/whatever"),
    ]);
    for (const response of responses) {
      expect(response.status).not.toBe(401);
      expect(response.status).not.toBe(407);
      expect(response.headers.get("www-authenticate")).toBeNull();
    }
  });

  it("the only refusals across the enabled/declared matrix are the four documented gate codes", async () => {
    const observed = new Set<string>();

    const enabled = harness();
    const cases = [
      () => enabled.app.request("/api/actions/restart-quiet", { method: "POST" }), // 200, no refusal
      () => enabled.app.request("/api/actions/nope", { method: "POST" }), // ACTION_UNKNOWN
      () => enabled.app.request("/api/actions/orphan", { method: "POST" }), // RUNNER_UNRESOLVED
      () =>
        enabled.app.request("/api/actions/deploy", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ count: "not-a-number" }),
        }), // PARAMS_INVALID
      () => enabled.app.request("/api/actions/runs/does-not-exist/cancel", { method: "POST" }), // RUN_NOT_FOUND (a lookup code, not a pre-run refusal)
      () => enabled.app.request("/api/actions/audit/does-not-exist"), // AUDIT_NOT_FOUND (a lookup code, not a pre-run refusal)
    ];
    for (const run of cases) {
      const response = await run();
      if (response.status >= 400) {
        const body = (await response.json()) as { code?: string };
        if (body.code !== undefined) observed.add(body.code);
      }
    }

    const disabled = await actionsApp();
    const disabledResponse = await disabled.app.request("/api/actions/restart-quiet", {
      method: "POST",
    });
    const disabledBody = (await disabledResponse.json()) as { code: string };
    observed.add(disabledBody.code);

    // The four pre-run refusal codes plus the two lookup codes the routes emit for
    // an unresolved run/audit id — no other refusal class exists. A future route
    // adding a fifth pre-run refusal or a new lookup code must add it here deliberately.
    expect(observed).toEqual(
      new Set([
        "ACTIONS_DISABLED",
        "ACTION_UNKNOWN",
        "RUNNER_UNRESOLVED",
        "PARAMS_INVALID",
        "RUN_NOT_FOUND",
        "AUDIT_NOT_FOUND",
      ]),
    );
  });
});
