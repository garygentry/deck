import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { READY_TIMEOUT_MS, startSpecApi, stopSpecApi, useSpecApi, type SpecApi } from "./spec-api.js";
import { seedTheme } from "./theme-seed.js";

/**
 * A sidecar in another language contributes a working page, end to end: the example NUT UPS
 * sidecar (`examples/sidecars/nut-ups/nut_ups.py`, Python) runs over a fake `upsc`; a `remote`
 * integration polls its `/deck/v1/data` with a bearer token from the environment and asks its
 * `/deck/v1/describe`; deck renders the described widgets with its own widget types on the
 * integration's page, lists the page in the sidebar and reports the sidecar's health.
 *
 * CI must run it: there a missing python3 fails the suite. Locally it is skipped with a reason.
 */

const REPO = dirname(dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url))))));
const SIDECAR = join(REPO, "examples/sidecars/nut-ups/nut_ups.py");
const TOKEN = "e2e-sidecar-token";
const HAS_PYTHON = spawnSync("python3", ["--version"]).status === 0;

/** A fake `upsc`, answering as NUT does. */
const UPSC = [
  "#!/bin/sh",
  "cat <<'OUT'",
  "battery.charge: 97",
  "battery.runtime: 2400",
  "device.model: Back-UPS 1500",
  "input.voltage: 231.0",
  "ups.load: 23",
  "ups.status: OL",
  "OUT",
].join("\n");

const main = (page: Page) => page.locator("main#main");
const region = (page: Page, name: string) => main(page).getByRole("region", { name, exact: true });

async function openUps(page: Page): Promise<void> {
  await page.goto("/power/ups");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(["UPS"], { timeout: 15_000 });
  await expect(region(page, "Status")).toContainText("OL", { timeout: 30_000 });
  await expect(main(page).locator("[aria-busy='true']")).toHaveCount(0, { timeout: 30_000 });
}

/** Start the sidecar on an ephemeral port; resolves with its base URL once it listens. */
async function startSidecar(bin: string): Promise<{ url: string; child: ChildProcess }> {
  const child = spawn("python3", ["-I", SIDECAR], {
    env: { PATH: `${bin}:${process.env.PATH ?? ""}`, PORT: "0", BIND: "127.0.0.1", NUT_UPS: "ups@nut-server", SIDECAR_TOKEN: TOKEN },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const port = await new Promise<string>((resolve, reject) => {
    let out = "";
    child.stdout!.on("data", (chunk: Buffer) => {
      out += chunk.toString();
      const match = /listening on (\d+)/.exec(out);
      if (match) resolve(match[1]!);
    });
    child.once("exit", (code) => reject(new Error(`sidecar exited (${code})`)));
    setTimeout(() => reject(new Error("sidecar did not start within 10s")), 10_000);
  });
  return { url: `http://127.0.0.1:${port}`, child };
}

test.describe("the example Python sidecar's page", () => {
  test.skip(!HAS_PYTHON && !process.env.CI, "python3 is not on PATH (CI runs this)");

  let api: SpecApi;
  let sidecar: ChildProcess | undefined;
  let bin: string | undefined;

  test.beforeAll(async () => {
    test.setTimeout(READY_TIMEOUT_MS * 2 + 30_000);
    // In CI the example must run: a missing python3 is a failure, never a skip.
    expect(HAS_PYTHON, "python3 is required to run the example sidecar").toBe(true);
    bin = mkdtempSync(join(tmpdir(), "deck-e2e-upsc-"));
    writeFileSync(join(bin, "upsc"), UPSC);
    chmodSync(join(bin, "upsc"), 0o755);
    const started = await startSidecar(bin);
    sidecar = started.child;
    api = await startSpecApi("remote-sidecar", {
      UPS_SIDECAR_TOKEN: TOKEN,
      DECK_E2E_INTEGRATIONS: JSON.stringify([
        {
          id: "ups",
          kind: "remote",
          title: "UPS",
          url: started.url,
          credentialEnv: "UPS_SIDECAR_TOKEN",
          auth: { scheme: "bearer" },
          pollIntervalMs: 2_000,
          ttlMs: 600_000,
          page: { path: "/power/ups", icon: "zap", nav: { group: "health", order: 0 } },
        },
      ]),
    });
  });

  test.afterAll(async () => {
    if (api !== undefined) await stopSpecApi(api);
    sidecar?.kill();
    if (bin !== undefined) rmSync(bin, { recursive: true, force: true });
  });

  test("renders the described widgets over the sidecar's data, with its links", async ({ page }) => {
    await useSpecApi(page, api.port);
    await page.setViewportSize({ width: 1280, height: 900 });
    await openUps(page);
    await expect(region(page, "Runtime")).toContainText("40m");
    await expect(region(page, "Load").getByRole("meter", { name: "Load" })).toHaveAttribute("aria-valuenow", "23");
    await expect(region(page, "Battery").getByRole("meter", { name: "Battery" })).toHaveAttribute("aria-valuenow", "97");
    await expect(region(page, "Details").getByRole("definition")).toHaveText(["Back-UPS 1500", "231 V"]);
    await expect(region(page, "Links").getByRole("link", { name: /NUT documentation/ })).toHaveAttribute("target", "_blank");
    const nav = page.getByRole("navigation", { name: "Primary" });
    await expect(nav.getByRole("link", { name: "UPS", exact: true })).toHaveAttribute("href", "/power/ups");
    // The sidecar is its own provider: its own health entry, naming data and describe.
    const health = await page.evaluate(async () => (await fetch("/api/health")).json());
    expect(health.providers.ups).toMatchObject({ ok: true, detail: expect.stringContaining("describe: ok (ups 1.0.0)") });
  });

  test("is one column below md, with no sideways scroll", async ({ page }) => {
    await useSpecApi(page, api.port);
    await page.setViewportSize({ width: 375, height: 800 });
    await openUps(page);
    const lefts = await main(page).locator('[data-slot="widget"]').evaluateAll((nodes) => nodes.map((node) => Math.round(node.getBoundingClientRect().left)));
    expect(new Set(lefts).size).toBe(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });

  for (const theme of ["light", "dark"] as const) {
    test(`has no serious or critical axe violations (${theme})`, async ({ page }) => {
      await useSpecApi(page, api.port);
      await seedTheme(page, theme);
      await page.setViewportSize({ width: 1280, height: 900 });
      await openUps(page);
      const { violations } = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
      const blocking = violations
        .filter((v) => v.impact === "serious" || v.impact === "critical")
        .map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(" ")).slice(0, 3).join(" | ")}`);
      expect(blocking, `axe violations on /power/ups (${theme})`).toEqual([]);
    });
  }
});
