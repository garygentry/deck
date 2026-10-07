import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";

/**
 * Capability-aware nav against a real server with the actions module OFF. The shared E2E API
 * runs with actions on, so this spec boots its own (the same helper, with
 * DECK_E2E_ACTIONS_ENABLED=false) on a free port and a runtime dir of its own, and forwards the
 * page's `/api/*` requests to it. Nothing here is a hand-written manifest: the nav and the
 * not-enabled page come from what that server serves.
 */

const webDir = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const READY_TIMEOUT_MS = 60_000;

/** A port the OS reports free right now (bound to 0, then released). */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => (typeof address === "object" && address !== null ? resolve(address.port) : reject(new Error("no port"))));
    });
  });
}

interface OffApi {
  child: ChildProcess;
  port: number;
  tmp: string;
}

/** Boot the helper with actions off; resolves once `/api/health` answers, rejects if it exits first. */
async function bootActionsOff(): Promise<OffApi> {
  const port = await freePort();
  const tmp = mkdtempSync(join(tmpdir(), "deck-e2e-actions-off-"));
  const child = spawn("bun", ["test/e2e/start-inventory-api.ts"], {
    cwd: webDir,
    env: {
      ...process.env,
      DECK_E2E_API_PORT: String(port),
      DECK_INVENTORY_E2E_RUNTIME_DIR: join(tmp, "runtime"),
      DECK_E2E_ACTIONS_ENABLED: "false",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const exited = new Promise<never>((_, reject) => {
    child.once("exit", (code) => reject(new Error(`actions-off API exited early (${code}): ${stderr.trim()}`)));
  });
  const ready = (async () => {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      try {
        if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return;
      } catch {
        // Not listening yet.
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error("actions-off API did not become ready");
  })();
  try {
    await Promise.race([ready, exited]);
  } catch (error) {
    await stop({ child, port, tmp });
    throw error;
  }
  exited.catch(() => undefined);
  return { child, port, tmp };
}

/** Stop the API we started (by its PID) and remove its own temp dir. */
async function stop(api: OffApi): Promise<void> {
  const { child } = api;
  if (child.exitCode === null && child.signalCode === null && child.pid !== undefined) {
    const gone = new Promise((resolve) => child.once("exit", resolve));
    process.kill(child.pid, "SIGTERM");
    await Promise.race([gone, new Promise((resolve) => setTimeout(resolve, 10_000))]);
    if (child.exitCode === null && child.signalCode === null) process.kill(child.pid, "SIGKILL");
  }
  rmSync(api.tmp, { recursive: true, force: true });
}

/** Send every `/api/*` request of the page to the actions-off API. */
async function useApi(page: Page, port: number): Promise<void> {
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    try {
      const response = await route.fetch({ url: `http://127.0.0.1:${port}${url.pathname}${url.search}` });
      await route.fulfill({ response });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/has been disposed|has been closed|Route is already handled|Test ended/i.test(message)) throw error;
    }
  });
}

const primaryNav = (page: Page) => page.getByRole("navigation", { name: "Primary" });

test.describe("capability-aware nav (actions off)", () => {
  let api: OffApi;

  test.beforeAll(async () => {
    test.setTimeout(READY_TIMEOUT_MS * 2 + 30_000);
    // A port taken between choosing and binding (EADDRINUSE) fails the boot: retry once.
    try {
      api = await bootActionsOff();
    } catch {
      api = await bootActionsOff();
    }
  });

  test.afterAll(async () => {
    if (api !== undefined) await stop(api);
  });

  test("the nav lists no Actions entry and no Operate group", async ({ page }) => {
    await useApi(page, api.port);
    await page.goto("/");
    const nav = primaryNav(page);
    await expect(nav.getByRole("link", { name: "Portal", exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(nav.getByRole("link", { name: "Hosts", exact: true })).toBeVisible();
    await expect(nav.locator('a[href="/actions"]')).toHaveCount(0);
    await expect(nav.locator('[data-sidebar="group-label"]', { hasText: "Operate" })).toHaveCount(0);
  });

  test("a direct hit on /actions says the module is off and names DECK_ACTIONS_ENABLED", async ({ page }) => {
    await useApi(page, api.port);
    await page.goto("/actions");
    const notEnabled = page.locator('[data-slot="module-not-enabled-page"]');
    await expect(notEnabled).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(["Actions"]);
    await expect(notEnabled.getByRole("status")).toContainText("The actions module is not enabled");
    await expect(notEnabled.getByRole("status")).toContainText("DECK_ACTIONS_ENABLED=true");
    await expect(primaryNav(page).locator('a[href="/actions"]')).toHaveCount(0);
  });
});

test("with actions on (the shared API), the nav lists Actions and /actions renders the page", async ({ page }) => {
  await page.goto("/actions");
  await expect(primaryNav(page).getByRole("link", { name: "Actions", exact: true })).toHaveAttribute("href", "/actions", { timeout: 15_000 });
  await expect(page.getByRole("heading", { name: "Actions", level: 1 })).toBeVisible();
  await expect(page.locator('[data-slot="module-not-enabled-page"]')).toHaveCount(0);
});
