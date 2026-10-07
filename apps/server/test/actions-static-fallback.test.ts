import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Logger } from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createActionExecutor } from "../src/actions/executor.js";
import { createAuditStore } from "../src/actions/audit.js";
import type { ActionsDeps, ActionsRuntime } from "../src/actions/runtime.js";
import { createApp, type AppDeps } from "../src/server/app.js";
import type { DeckConfig } from "../src/contract/index.js";
import { createFakeSpawner } from "./util/fake-spawner.js";
import { makeDataDir } from "./util/tmp-data.js";

/**
 * Locks in the registration order `app.ts` documents: action routes are registered
 * before the static/SPA fallback so `/api/actions/*` always matches the API rather
 * than being rewritten to `index.html`. No prior gate exercised this with a
 * `webDistDir` actually configured — every other test/smoke leg boots without one.
 */

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures/actions-estate");

function fakeLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
}

const noProviders = { read: () => undefined, count: () => 0, listHealth: () => ({}), listProviders: () => [] };

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

/** A tmp dir containing a minimal index.html, for `webDistDir`. */
function makeWebDist(): string {
  const dir = mkdtempSync(join(tmpdir(), "deck-webdist-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>deck</title>");
  return dir;
}

describe("action routes vs. the static/SPA fallback (registration order)", () => {
  it("matches the action API, not the index rewrite, when the capability is off", async () => {
    const webDistDir = makeWebDist();
    const config: DeckConfig = {
      schemaVersion: 1,
      estate: { name: "x" },
    } as DeckConfig;
    const deps: AppDeps = {
      config,
      providers: noProviders,
      logger: fakeLogger(),
      webDistDir,
    };
    const app = createApp(deps);

    const response = await app.request("/api/actions/anything", { method: "POST" });
    // A JSON refusal, never the HTML index-rewrite the static fallback would serve.
    expect(response.status).toBe(403);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toMatchObject({ code: "ACTIONS_DISABLED" });
  });

  it("matches the action API, not the index rewrite, when the capability is on", async () => {
    const webDistDir = makeWebDist();
    const { dir, cleanup } = makeDataDir();
    cleanups.push(cleanup);

    const config = JSON.parse(
      readFileSync(join(fixturesDir, "config.json"), "utf8"),
    ) as DeckConfig;
    const runnersRaw = JSON.parse(
      readFileSync(join(fixturesDir, "runners.json"), "utf8"),
    ) as Record<string, string>;

    const spawner = createFakeSpawner({ stdout: [new TextEncoder().encode("ok\n")], exitCode: 0 });
    const audit = createAuditStore(dir);
    const executor = createActionExecutor({
      spawner,
      audit,
      timeoutMs: 600_000,
      logger: fakeLogger(),
    });
    const runtime: ActionsRuntime = {
      enabled: true,
      timeoutMs: 600_000,
      dataDir: dir,
      runners: new Map(Object.entries(runnersRaw)),
    };
    const actions: ActionsDeps = { runtime, executor, audit };

    const deps: AppDeps = {
      config,
      providers: noProviders,
      logger: fakeLogger(),
      actions,
      webDistDir,
    };
    const app = createApp(deps);

    const response = await app.request("/api/actions/restart-quiet", { method: "POST" });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/x-ndjson");
  });
});
