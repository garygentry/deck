import { expect, test } from "@playwright/test";

/**
 * Cascade-layer contract. `src/styles/app.css` declares
 * `theme, base, components, utilities`: Preflight (`base`) resets every
 * element, component CSS (e.g. the highlight.js theme) sits above it, and a
 * utility class beats both. Probe rules are injected into the page's existing
 * layers, so the assertions exercise the order the real bundle establishes.
 */

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("main#main")).toBeVisible();
  await page.locator("main#main").evaluate((main) => {
    main.insertAdjacentHTML("beforeend", '<dl><dt>probe</dt><dd id="layer-probe">x</dd></dl>');
  });
});

test("Preflight resets element defaults everywhere, including page content", async ({ page }) => {
  // The UA stylesheet indents <dd> by 40px; Preflight zeroes every margin.
  await expect(page.locator("#layer-probe")).toHaveCSS("margin-left", "0px");
  // The sidebar nav list is shell UI: no UA list indent either.
  const list = page.getByRole("navigation", { name: "Primary" }).locator("ul").first();
  await expect(list).toHaveCSS("padding-left", "0px");
});

test("a components-layer rule wins over a base-layer rule", async ({ page }) => {
  await page.addStyleTag({
    content:
      "@layer base { #layer-probe { margin-left: 1px; } } @layer components { #layer-probe { margin-left: 5px; } }",
  });
  await expect(page.locator("#layer-probe")).toHaveCSS("margin-left", "5px");
});

test("a utility-layer class wins over a more specific components-layer rule", async ({
  page,
}) => {
  await page.addStyleTag({
    content:
      "@layer components { main#main dl dd#layer-probe { margin-left: 5px; } } @layer utilities { .layer-probe { margin-left: 7px; } }",
  });
  await page.locator("#layer-probe").evaluate((el) => el.classList.add("layer-probe"));
  await expect(page.locator("#layer-probe")).toHaveCSS("margin-left", "7px");
});

test("the body uses the theme background and 14px text", async ({ page }) => {
  const body = page.locator("body");
  await expect(body).toHaveCSS("font-size", "14px");
  const [bodyBg, tokenBg] = await page.evaluate(() => {
    const probe = document.createElement("div");
    probe.style.background = "var(--background)";
    document.body.append(probe);
    const token = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return [getComputedStyle(document.body).backgroundColor, token];
  });
  expect(bodyBg).toBe(tokenBg);
});
