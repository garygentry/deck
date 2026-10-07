import { defineConfig, devices } from "@playwright/test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const webDir = dirname(fileURLToPath(import.meta.url));
const runtimeDir = resolve(webDir, ".tmp/inventory-e2e");

// Assign the one absolute mutable-runtime root before Playwright forks workers,
// then pass the same value to the Bun API web-server process. Item 021 creates
// the helper that consumes it; this config only publishes the shared location.
process.env.DECK_INVENTORY_E2E_RUNTIME_DIR = runtimeDir;

// The API port defaults to 8788; set DECK_E2E_API_PORT when another local
// process already holds it (reuseExistingServer would otherwise attach to it).
const apiPort = Number(process.env.DECK_E2E_API_PORT ?? 8788);
process.env.DECK_E2E_API_PORT = String(apiPort);
// The Vite port defaults to 4173; set DECK_E2E_WEB_PORT to run a second suite
// alongside (e.g. from another git worktree) without attaching to its server.
const webPort = Number(process.env.DECK_E2E_WEB_PORT ?? 4173);

export default defineConfig({
  testDir: "./test/e2e",
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  // On CI, stop a shard after 10 failures. A mass failure (e.g. missing visual
  // baselines) otherwise runs every test to its 95 s expect timeout plus a
  // retry, which once held a shard for ~1.8 h of metered minutes.
  maxFailures: process.env.CI ? 10 : 0,
  timeout: 120_000,
  expect: { timeout: 95_000 },
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: `http://127.0.0.1:${webPort}`,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    ...devices["Desktop Chrome"],
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      // `exec` replaces the wrapping shell with Bun so Playwright's teardown
      // signal reaches the API process directly and its owned cleanup runs.
      command: "exec bun test/e2e/start-inventory-api.ts",
      cwd: webDir,
      env: { ...process.env, DECK_INVENTORY_E2E_RUNTIME_DIR: runtimeDir },
      port: apiPort,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
      // Playwright kills web servers with SIGKILL by default; request SIGTERM so
      // the API helper's owned cleanup runs before the process exits.
      gracefulShutdown: { signal: "SIGTERM", timeout: 10_000 },
    },
    {
      command: `pnpm vite --host 127.0.0.1 --port ${webPort} --strictPort`,
      cwd: webDir,
      env: { ...process.env, DECK_PROXY_TARGET: `http://127.0.0.1:${apiPort}` },
      port: webPort,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
  ],
});
