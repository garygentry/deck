/**
 * `GET /api/ui` golden: the resolved UI manifest the real boot path serves for
 * `examples/estate`, with the default env and with every opt-in capability on, compared
 * with the committed goldens in `test/golden/ui/`. A diff means the UI deck renders changed:
 * fix the code, or refresh the goldens and explain the diff in review:
 *
 *   DECK_UPDATE_GOLDENS=1 pnpm --filter @deck/server exec vitest run test/ui-golden.test.ts
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";

import { capture, createdApps, SERVER_ROOT, SETTLE_TIMEOUT_MS, updateRequested, type ParityCase } from "./parity/harness.js";

vi.setConfig({ testTimeout: SETTLE_TIMEOUT_MS * 3 });

vi.mock("../src/server/app.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/server/app.js")>();
  return {
    ...original,
    createApp: (deps: Parameters<typeof original.createApp>[0]): Hono => {
      const app = original.createApp(deps);
      createdApps.push(app);
      return app;
    },
  };
});

const CASES: ParityCase[] = [
  { id: "examples-estate", dir: "../../examples/estate" },
  {
    id: "examples-estate.all-features",
    dir: "../../examples/estate",
    env: {
      DECK_ACTIONS_ENABLED: "true",
      DECK_DATA_DIR: "<tmp>/data",
      DECK_RUNNERS_FILE: "<server>/test/fixtures/actions-estate/runners.json",
      DECK_METRICS_ENABLED: "true",
    },
  },
];

async function captureUi(parityCase: ParityCase): Promise<unknown> {
  let body: unknown;
  await capture(parityCase, {
    onApp: async (app) => {
      const response = await app.request("/api/ui");
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("application/json");
      body = await response.json();
    },
  });
  return body;
}

describe("GET /api/ui golden", () => {
  for (const parityCase of CASES) {
    it(parityCase.id, async () => {
      const actual = await captureUi(parityCase);
      const path = join(SERVER_ROOT, "test/golden/ui", `${parityCase.id}.json`);
      const serialised = `${JSON.stringify(actual, null, 2)}\n`;
      if (updateRequested()) writeFileSync(path, serialised);
      expect(existsSync(path), `missing golden ${path}`).toBe(true);
      expect(serialised).toBe(readFileSync(path, "utf8"));
    });
  }

  it("resolves identically on a second boot", async () => {
    expect(await captureUi(CASES[1]!)).toEqual(await captureUi(CASES[1]!));
  });
});
