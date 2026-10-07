import { isAbsolute } from "node:path";
import { describe, expect, it } from "vitest";

import config from "../playwright.config.js";

/**
 * Configuration-focused assertions for the Playwright + Vite API bridge (item 020).
 *
 * The config is loaded directly. Its Bun API and Vite web-server commands are plain
 * strings, so importing the config never requires `test/e2e/start-inventory-api.ts`
 * or the mutable-runtime helper (item 021) to exist yet.
 */
describe("playwright.config", () => {
  it("defines exactly one Chromium project", () => {
    expect(config.projects).toHaveLength(1);
    expect(config.projects?.[0]?.name).toBe("chromium");
  });

  it("uses one worker with no full parallelism", () => {
    expect(config.workers).toBe(1);
    expect(config.fullyParallel).toBe(false);
  });

  it("emits diagnostics only on retry", () => {
    expect(config.use?.trace).toBe("on-first-retry");
    expect(config.use?.screenshot).toBe("only-on-failure");
    expect(config.use?.video).toBe("retain-on-failure");
  });

  it("assigns one absolute mutable-runtime dir shared with the API process", () => {
    const runtimeDir = process.env.DECK_INVENTORY_E2E_RUNTIME_DIR;
    expect(runtimeDir).toBeTruthy();
    expect(isAbsolute(runtimeDir ?? "")).toBe(true);

    const servers = Array.isArray(config.webServer)
      ? config.webServer
      : config.webServer
        ? [config.webServer]
        : [];
    expect(servers).toHaveLength(2);

    const [api, vite] = servers;

    // The API command is Bun; it carries the same absolute runtime dir.
    expect(api?.command).toContain("bun ");
    expect(api?.command).toContain("start-inventory-api.ts");
    expect(api?.port).toBe(8788);
    expect(api?.env?.DECK_INVENTORY_E2E_RUNTIME_DIR).toBe(runtimeDir);

    // The second command is Vite.
    expect(vite?.command).toContain("vite");
    expect(vite?.port).toBe(4173);

    // Both web-server cwd values are absolute, independent of process cwd.
    expect(isAbsolute(api?.cwd ?? "")).toBe(true);
    expect(isAbsolute(vite?.cwd ?? "")).toBe(true);
  });
});
