import { expect, test, type Page } from "@playwright/test";
import { routePortalFixture } from "./portal-fixture.js";

/**
 * The shared data layer, observed on the network: one `/api/config` and one `/api/ui`
 * request per page load however many surfaces read them, and one request per poll for a
 * provider the portal page and the header pill both read.
 */

function countRequests(page: Page): (path: string) => number {
  const seen: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/api/")) seen.push(url.pathname);
  });
  return (path) => seen.filter((p) => p === path).length;
}

test("a page load reads /api/config and /api/ui once, across client navigation", async ({ page }) => {
  const count = countRequests(page);
  await routePortalFixture(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Portal" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Grafana" })).toBeVisible();

  // Client-side navigation through every config reader (the inventory store, monitoring, the
  // source browsers' owned configs and docs, the actions ConfigGate) adds no request.
  const nav = page.getByRole("navigation", { name: "Primary" });
  for (const [link, heading] of [
    ["Hosts", "Hosts"],
    ["Monitoring", "Monitoring"],
    ["Configs", "Configs"],
    ["Docs", "Docs"],
    ["Actions", "Actions"],
  ] as const) {
    await nav.getByRole("link", { name: link, exact: true }).click();
    await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
  }
  // Let requests issued from mount effects land before counting.
  await page.waitForLoadState("networkidle");

  expect(count("/api/config")).toBe(1);
  expect(count("/api/ui")).toBe(1);
  // Discovery moved into the UI manifest.
  expect(count("/api/providers")).toBe(0);
});

test("the portal page and the endpoint pill share each docker and gatus poll", async ({ page }) => {
  await page.clock.install();
  const count = countRequests(page);
  await routePortalFixture(page);
  await page.goto("/");
  await expect(page.getByRole("link", { name: "Grafana" })).toBeVisible();
  // The endpoint pill reads gatus too: both surfaces are up before counting.
  await expect(page.locator('[data-slot="health-header"]')).toContainText("up");

  expect(count("/api/providers/docker")).toBe(1);
  expect(count("/api/providers/gatus")).toBe(1);

  // One poll tick later: one more request each, not one per surface.
  await page.clock.runFor(30_000);
  await expect.poll(() => count("/api/providers/gatus")).toBe(2);
  expect(count("/api/providers/docker")).toBe(2);
  expect(count("/api/config")).toBe(1);
});
