import { expect, test } from "@playwright/test";

import { startSpecApi, stopSpecApi, type SpecApi } from "./spec-api.js";

/**
 * A source's raw images are served inert. An SVG is a document that can hold script; committed to
 * a docs repository and opened by its raw URL, it would run as deck, on deck's origin. This spec
 * boots its own API with such an SVG in the docs source, opens its raw URL straight from the API
 * (as a link to it would), and proves the script did not run, and that the same bytes served
 * without the route's policy do run (so the check can see script run at all).
 */

const ACTIVE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><script>document.documentElement.setAttribute("data-ran", "1")</script><rect width="8" height="8"/></svg>';

let api: SpecApi;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  test.setTimeout(120_000);
  api = await startSpecApi("sources-raw", { DECK_E2E_DOCS_FILES: JSON.stringify({ "active.svg": ACTIVE_SVG }) });
});

test.afterAll(async () => {
  if (api !== undefined) await stopSpecApi(api);
});

test("an SVG with script, opened by its raw URL, runs no script", async ({ page, request }) => {
  const origin = `http://127.0.0.1:${api.port}`;
  const rawUrl = `${origin}/api/sources/docs/raw?path=active.svg`;
  // The provider's first poll primes the source; until then a read is unavailable.
  await expect.poll(async () => (await request.get(rawUrl)).status(), { timeout: 30_000 }).toBe(200);

  const response = await page.goto(rawUrl);
  // The document is the SVG itself, served as committed, and its script did not run.
  await expect(page.locator("svg rect")).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.getAttribute("data-ran"))).toBeNull();
  expect(response?.headers()["content-type"]).toBe("image/svg+xml");
  expect(response?.headers()["content-security-policy"]).toContain("sandbox");

  // The control: the same bytes from the same origin with no policy run their script.
  const controlUrl = `${origin}/__control/active.svg`;
  await page.route(controlUrl, (route) => route.fulfill({ status: 200, contentType: "image/svg+xml", body: ACTIVE_SVG }));
  await page.goto(controlUrl);
  await expect.poll(() => page.evaluate(() => document.documentElement.getAttribute("data-ran"))).toBe("1");
});
