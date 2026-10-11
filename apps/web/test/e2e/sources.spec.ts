import { expect, test, type Page } from "@playwright/test";

/**
 * Browser presentation of the read-only sources surfaces (Docs + Configs) against the real Bun
 * API + Vite harness. The API helper (`start-inventory-api.ts`) materializes the two committed
 * local-path fixtures — `markdown-tree/` and `file-tree/` (the latter with a setup-only oversized
 * file and an escape symlink) — into the ephemeral runtime root and declares them as `docs` and
 * `configs` sources in an overlay layer. Local-path sources acquire in place, so no git and no
 * network are involved. Neither source sets an `owner`, so the owned-configs fragment on
 * the inventory detail pages stays empty and the inventory suite is unaffected.
 *
 * Coverage: browsing a markdown-tree source (GFM render, syntax highlight, an internal relative
 * link, a relative image served through the raw route), browsing a file-tree source (highlighted
 * config, oversized → truncation notice, binary → placeholder), and that neither surface exposes
 * an edit/save/commit affordance.
 */

/**
 * Navigate to a sources route and wait for its manifest tree to render, retrying the load if the
 * Vite dev server serves a blank shell or the provider's first poll has not yet primed the tree.
 */
async function openSource(page: Page, route: string, heading: string): Promise<void> {
  await expect(async () => {
    await page.goto(route);
    await expect(page.getByRole("banner")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("heading", { name: heading, level: 1 })).toBeVisible({
      timeout: 15_000,
    });
    // The navigation tree renders only once the provider produced a manifest with files.
    await expect(page.getByRole("tree", { name: "Files" })).toBeVisible({ timeout: 15_000 });
  }).toPass({ timeout: 60_000, intervals: [1000, 2000, 4000] });
}

/** The Docs markdown document view (the sanitized-HTML article). */
const docArticle = (page: Page) => page.getByRole("article", { name: "Document" });

/** The Configs file view: a figure named by its caption (the file path). */
const fileFigure = (page: Page, name?: string) =>
  name === undefined ? page.getByRole("main").getByRole("figure") : page.getByRole("figure", { name });

test.describe("sources: docs + configs read-only browsing", () => {
  test("browse a markdown-tree source: GFM, highlight, internal link, image", async ({
    page,
  }) => {
    await openSource(page, "/docs", "Docs");

    // Open the GFM document from the navigation tree.
    await page.getByRole("treeitem", { name: "index.md" }).click();

    // Rendered GFM: a table and a highlight.js-classed fenced code block are visible.
    await expect(docArticle(page).getByRole("table")).toBeVisible({ timeout: 15_000 });
    await expect(docArticle(page).locator("code.hljs")).toBeVisible();
    // The task list rendered a disabled checkbox (read-only GFM).
    const task = docArticle(page).getByRole("checkbox").first();
    await expect(task).toBeVisible();
    await expect(task).toBeDisabled();

    // Follow the internal relative link → the URL carries the rewritten source+path query and the
    // second document renders in place (no full-page navigation away from /docs).
    await docArticle(page).getByRole("link", { name: "image demo" }).click();
    await expect(page).toHaveURL(/\/docs\?.*source=docs.*path=images\.md/);

    // The second document displays a relative image served through the confined raw route.
    const image = docArticle(page).locator("img");
    await expect(image).toBeVisible({ timeout: 15_000 });
    await expect(image).toHaveAttribute("src", /\/api\/sources\/docs\/raw\?path=/);
    // The asset actually decoded in the browser (raw route served real image bytes).
    await expect
      .poll(() => image.evaluate((el: HTMLImageElement) => el.naturalWidth), { timeout: 15_000 })
      .toBeGreaterThan(0);
  });

  test("browse a file-tree source: highlight, truncated, binary", async ({ page }) => {
    await openSource(page, "/configs", "Configs");

    // A highlightable config file renders with visible syntax highlighting and no truncation.
    await page.getByRole("treeitem", { name: "app.yaml" }).click();
    // `hljs` is highlight.js's own output contract (the token markup), not a styling hook.
    await expect(fileFigure(page, "app.yaml").locator("code.hljs")).toBeVisible({ timeout: 15_000 });

    // The oversized file (> MAX_FILE_BYTES) renders the truncation notice and NO body.
    await page.getByRole("treeitem", { name: "big.txt" }).click();
    await expect(page.getByText(/too large to display/i)).toBeVisible({ timeout: 15_000 });
    await expect(fileFigure(page)).toHaveCount(0);

    // The binary file renders the placeholder and NO body (its content is never fetched as text).
    await page.getByRole("treeitem", { name: "data.bin" }).click();
    await expect(page.getByText(/binary file/i)).toBeVisible({ timeout: 15_000 });
    await expect(fileFigure(page)).toHaveCount(0);
  });

  test("no mutating affordance is exposed on either surface", async ({ page }) => {
    const mutating = /\b(edit|save|commit|write|create|update|delete|remove|new|push|apply)\b/i;

    for (const [route, heading] of [
      ["/docs", "Docs"],
      ["/configs", "Configs"],
    ] as const) {
      await openSource(page, route, heading);
      const names = await page.getByRole("button").evaluateAll((buttons) =>
        buttons.map((b) => (b.getAttribute("aria-label") ?? b.textContent ?? "").trim()),
      );
      for (const name of names) {
        expect(name, `unexpected mutating control "${name}" on ${route}`).not.toMatch(mutating);
      }
    }
  });
});
