import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { DeckConfig } from "../src/contract/index.js";
import { ACTIONS_FIXTURES_DIR, actionsApp } from "./util/actions-module.js";
import { createFakeSpawner } from "../../../modules/actions/test/server/util/fake-spawner.js";
import { makeDataDir } from "./util/tmp-data.js";

/**
 * Locks in the registration order `app.ts` documents: module routes (the actions module's
 * `/api/actions` alias, whether it runs or answers its fixed switched-off responses) are
 * mounted before the static/SPA fallback, so `/api/actions/*` always matches the API rather
 * than being rewritten to `index.html`, with a `webDistDir` actually configured.
 */

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
    const config = { schemaVersion: 2, estate: { name: "x" } } as DeckConfig;
    const { app } = await actionsApp({ config, webDistDir });

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
    const spawner = createFakeSpawner({ stdout: [new TextEncoder().encode("ok\n")], exitCode: 0 });
    const { app, host } = await actionsApp({
      webDistDir,
      createSpawner: () => spawner,
      env: { DECK_ACTIONS_ENABLED: "true", DECK_DATA_DIR: dir, DECK_RUNNERS_FILE: join(ACTIONS_FIXTURES_DIR, "runners.json") },
    });
    cleanups.push(() => void host.stop());

    const response = await app.request("/api/actions/restart-quiet", { method: "POST" });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/x-ndjson");
    await response.text();
  });
});
