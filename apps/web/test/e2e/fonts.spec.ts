import { expect, test } from "@playwright/test";

/**
 * Fonts are self-hosted (D9): home labs are often offline or egress-restricted,
 * so the app must never reach a font CDN (or any other origin) to render.
 */

const ROUTES = ["/", "/hosts", "/drift", "/docs", "/monitoring"];

test("every request stays same-origin while rendering the main routes", async ({
  page,
  baseURL,
}) => {
  const origin = new URL(baseURL!).origin;
  const foreign: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.protocol === "data:" || url.protocol === "blob:") return;
    if (url.origin !== origin) foreign.push(request.url());
  });

  for (const route of ROUTES) {
    await page.goto(route, { waitUntil: "networkidle" });
  }

  expect(foreign).toEqual([]);
});

test("Geist Sans and Geist Mono load from the bundle", async ({ page }) => {
  await page.goto("/", { waitUntil: "networkidle" });
  const fonts = await page.evaluate(async () => {
    await Promise.all([
      document.fonts.load('16px "Geist Variable"'),
      document.fonts.load('16px "Geist Mono Variable"'),
    ]);
    // `document.fonts.check` is also true for an unknown family, so look for a
    // loaded FontFace of each family instead.
    const loaded = (family: string): boolean =>
      [...document.fonts].some(
        (face) => face.family.replace(/["']/g, "") === family && face.status === "loaded",
      );
    return {
      sans: loaded("Geist Variable"),
      mono: loaded("Geist Mono Variable"),
      body: getComputedStyle(document.body).fontFamily,
    };
  });
  expect(fonts.sans).toBe(true);
  expect(fonts.mono).toBe(true);
  expect(fonts.body).toContain("Geist Variable");
});
