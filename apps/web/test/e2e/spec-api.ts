import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";

/**
 * A spec-local real API: the shared E2E helper (`start-inventory-api.ts`) booted with env of
 * the spec's own, on a free port and a runtime dir of its own. A spec forwards its page's
 * `/api/*` requests to it, so what it asserts comes from what that server serves.
 */

const webDir = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
export const READY_TIMEOUT_MS = 60_000;

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

export interface SpecApi {
  child: ChildProcess;
  port: number;
  tmp: string;
}

/** Boot the helper with `env`; resolves once `/api/health` answers, rejects if it exits first. */
async function bootOnce(name: string, env: Record<string, string>): Promise<SpecApi> {
  const port = await freePort();
  const tmp = mkdtempSync(join(tmpdir(), `deck-e2e-${name}-`));
  const child = spawn("bun", ["test/e2e/start-inventory-api.ts"], {
    cwd: webDir,
    env: {
      ...process.env,
      DECK_E2E_API_PORT: String(port),
      DECK_INVENTORY_E2E_RUNTIME_DIR: join(tmp, "runtime"),
      ...env,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const exited = new Promise<never>((_, reject) => {
    child.once("exit", (code) => reject(new Error(`${name} API exited early (${code}): ${stderr.trim()}`)));
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
    throw new Error(`${name} API did not become ready`);
  })();
  try {
    await Promise.race([ready, exited]);
  } catch (error) {
    await stopSpecApi({ child, port, tmp });
    throw error;
  }
  exited.catch(() => undefined);
  return { child, port, tmp };
}

/**
 * Boot a spec-local API. A port taken between choosing and binding (EADDRINUSE) fails the
 * boot, so it is retried once.
 */
export async function startSpecApi(name: string, env: Record<string, string>): Promise<SpecApi> {
  try {
    return await bootOnce(name, env);
  } catch {
    return bootOnce(name, env);
  }
}

/** Stop the API we started (by its PID) and remove its own temp dir. */
export async function stopSpecApi(api: SpecApi): Promise<void> {
  const { child } = api;
  if (child.exitCode === null && child.signalCode === null && child.pid !== undefined) {
    const gone = new Promise((resolve) => child.once("exit", resolve));
    process.kill(child.pid, "SIGTERM");
    await Promise.race([gone, new Promise((resolve) => setTimeout(resolve, 10_000))]);
    if (child.exitCode === null && child.signalCode === null) process.kill(child.pid, "SIGKILL");
  }
  rmSync(api.tmp, { recursive: true, force: true });
}

/**
 * Send every `/api/*` request of the page to the spec-local API, and every `/modules/*` one
 * (runtime modules' web halves, which the API serves).
 */
export async function useSpecApi(page: Page, port: number): Promise<void> {
  await page.route((url) => url.pathname.startsWith("/api/") || url.pathname.startsWith("/modules/"), async (route) => {
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
