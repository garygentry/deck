import { expect, test, type Page } from "@playwright/test";
import { FIXTURE } from "./inventory-fixture.js";

/**
 * Visual baselines for the drift & coverage surfaces: the /drift page (with and
 * without an active entity scope) and the host-detail findings fragment.
 *
 * Like the workbench baselines, these are generated and verified on CI Linux
 * only (font rasterisation differs across hosts). Locally they are skipped
 * unless UPDATE_VISUALS is set; refresh them in CI with the `update_visuals`
 * workflow_dispatch input.
 *
 * Determinism: the E2E API stamps its snapshot with real "now" timestamps, so
 * the snapshot endpoint is intercepted with a fixed envelope built around
 * FROZEN_NOW, and the browser clock is frozen at the same instant. Every age,
 * waiver classification and timestamp on the page is therefore fixed.
 */

const VISUALS = Boolean(process.env.CI || process.env.UPDATE_VISUALS);
const WIDTHS = [375, 768, 1280] as const;
const THEMES = ["light", "dark"] as const;
const FROZEN_NOW = new Date("2026-01-15T12:00:00Z");

// The shell chrome is sticky (it would overlay a tall capture) and carries live
// data (the health header). Hide it, so the capture is just the page.
const HIDE_SHELL =
  'header[aria-label="Deck"], [data-slot="sidebar"] { display: none !important; }';

const at = (offsetMs: number): string => new Date(FROZEN_NOW.getTime() + offsetMs).toISOString();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** A fixed, schema-shaped snapshot envelope with every drift and coverage state. */
function fixedEnvelope(): Record<string, unknown> {
  const now = at(0);
  const hosts = [
    { name: FIXTURE.hostAlpha, coverage: "collected", collectedAt: at(-5 * 60_000), reachable: true },
    { name: FIXTURE.hostBravo, coverage: "collected", collectedAt: at(-2 * DAY), reachable: true },
    {
      name: FIXTURE.hostCharlie,
      coverage: "partial",
      collectedAt: at(-HOUR),
      reachable: true,
      collectors: {
        succeeded: ["system"],
        failed: [{ name: "containers", reason: "Socket timed out after 5s." }],
      },
    },
    { name: FIXTURE.hostDelta, coverage: "unreachable", reachable: false },
  ];
  const drift = [
    {
      id: "visual-finding-001",
      severity: "error",
      location: { host: FIXTURE.hostAlpha },
      category: "config",
      message: "Managed config /etc/app.conf differs from the declaration.",
      path: "/etc/app.conf",
      expected: { mode: "0640", owner: "app" },
      observed: { mode: "0644", owner: "root" },
    },
    {
      id: "visual-finding-002",
      severity: "warning",
      location: { host: FIXTURE.hostAlpha, service: FIXTURE.serviceWeb },
      category: "service",
      message: "Replica count differs from the declaration.",
      expected: 3,
      observed: 1,
    },
    {
      id: "visual-finding-003",
      severity: "info",
      location: { host: FIXTURE.hostAlpha },
      category: "package",
      message: "A newer package version is available.",
      waiver: { reason: "Pinned until the next maintenance window.", who: "ops", until: at(30 * DAY) },
    },
    {
      id: "visual-finding-004",
      severity: "warning",
      location: { host: FIXTURE.hostBravo },
      category: "config",
      message: "Waiver on a sysctl drift has lapsed.",
      waiver: { reason: "Temporary tuning.", who: "ops", until: at(-3 * DAY) },
    },
    {
      id: "visual-finding-005",
      severity: "error",
      location: { host: "visual-orphan-host.invalid" },
      category: "inventory",
      message: "Drift reported for a host absent from inventory.",
    },
  ];
  return {
    id: "snapshot",
    kind: "snapshot",
    freshness: { state: "fresh", observedAt: now, ageMs: 0, ttlMs: 60_000 },
    data: {
      snapshot: { schemaVersion: 1, generatedAt: now, hosts, services: [], drift },
      findings: [],
      hostStates: {
        [FIXTURE.hostAlpha]: { state: "fresh", pastStaleThreshold: false, collectedAt: at(-5 * 60_000) },
        [FIXTURE.hostBravo]: { state: "stale", pastStaleThreshold: true, collectedAt: at(-2 * DAY) },
        [FIXTURE.hostCharlie]: { state: "partial", pastStaleThreshold: false, collectedAt: at(-HOUR) },
        [FIXTURE.hostDelta]: { state: "unreachable", pastStaleThreshold: false, collectedAt: null },
        [FIXTURE.hostEcho]: { state: "never-collected", pastStaleThreshold: false, collectedAt: null },
      },
      lastReadAt: now,
      readError: null,
    },
    error: null,
  };
}

async function open(page: Page, theme: string, width: number, path: string): Promise<void> {
  await page.clock.setFixedTime(FROZEN_NOW);
  await page.addInitScript((mode) => localStorage.setItem("deck-theme", mode), theme);
  await page.route("**/api/providers/snapshot", (route) => route.fulfill({ json: fixedEnvelope() }));
  await page.setViewportSize({ width, height: 900 });
  await page.goto(path);
  await page.addStyleTag({ content: HIDE_SHELL });
  await expect(page.getByRole("navigation", { name: "Primary" })).toBeHidden();
}

const SHOT = { fullPage: true, animations: "disabled", caret: "hide" } as const;

test.describe("drift visual baselines", () => {
  test.skip(!VISUALS, "Visual baselines run on CI Linux only; set UPDATE_VISUALS=1 to run them");

  for (const theme of THEMES) {
    for (const width of WIDTHS) {
      test(`/drift ${width}px ${theme}`, async ({ page }) => {
        await open(page, theme, width, "/drift");
        await expect(page.locator('li[id^="drift-finding-"]')).toHaveCount(5);
        await page.evaluate(() => document.fonts.ready);
        await expect(page).toHaveScreenshot(`drift-${width}-${theme}.png`, SHOT);
      });

      test(`/drift scoped ${width}px ${theme}`, async ({ page }) => {
        await open(page, theme, width, `/drift?host=${encodeURIComponent(FIXTURE.hostAlpha)}`);
        await expect(
          page.getByRole("button", { name: `Remove entity scope Host ${FIXTURE.hostAlpha}` }),
        ).toBeVisible();
        await expect(page.locator('li[id^="drift-finding-"]')).toHaveCount(3);
        await page.evaluate(() => document.fonts.ready);
        await expect(page).toHaveScreenshot(`drift-scoped-${width}-${theme}.png`, SHOT);
      });

      test(`host findings fragment ${width}px ${theme}`, async ({ page }) => {
        await open(page, theme, width, `/hosts/${encodeURIComponent(FIXTURE.hostAlpha)}`);
        const fragment = page.locator('[data-slot="drift-findings"]');
        await expect(fragment.locator('li[id^="drift-fragment-finding-"]')).toHaveCount(3);
        await page.evaluate(() => document.fonts.ready);
        await expect(fragment).toHaveScreenshot(`drift-fragment-${width}-${theme}.png`, {
          animations: "disabled",
          caret: "hide",
        });
      });
    }
  }
});
