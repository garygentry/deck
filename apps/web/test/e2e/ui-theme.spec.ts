import { serializeDeckBoot, type DeckBootTheme } from "@deck/contract";
import { expect, test, type Page } from "@playwright/test";

/**
 * The operator's theme settings (`ui.theme.preset`, `density`, `radius`) in a real browser.
 * The server writes them into `index.html`'s boot object; the Vite dev server this suite runs
 * against writes nothing, so each test writes the boot object into the document itself, as the
 * server would (the server's side is covered by its index-html test). The pre-paint script then
 * sets `data-theme-*` on <html>, and theme.css and the `density-compact:` variant restyle the page.
 */

const BOOT_ELEMENT = '<script type="application/json" id="deck-boot"></script>';

async function withBootTheme(page: Page, theme: DeckBootTheme): Promise<void> {
  await page.route(
    (url) => url.pathname === "/_ui",
    async (route) => {
      const response = await route.fetch();
      const html = (await response.text()).replace(
        BOOT_ELEMENT,
        `<script type="application/json" id="deck-boot">${serializeDeckBoot({ bootApi: 1, brand: { title: "Deck" }, theme })}</script>`,
      );
      await route.fulfill({ response, body: html });
    },
  );
}

const rootToken = (page: Page, token: string): Promise<string> =>
  page.evaluate((name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim(), token);

const attributes = (page: Page) =>
  page.evaluate(() => ["preset", "density", "radius"].map((name) => document.documentElement.getAttribute(`data-theme-${name}`)));

interface Spacing {
  cellHeight: number;
  cellPaddingTop: number;
  listItemPaddingTop: number;
  sectionGap: number;
  cardPadding: number;
  cardRadius: number;
}

/** Spacing and radius of the workbench's first DataTable cell, List row and card Section. */
async function spacing(page: Page): Promise<Spacing> {
  await expect(page.locator('[data-slot="data-table"] td').first()).toBeVisible({ timeout: 15_000 });
  return page.evaluate(() => {
    const style = (selector: string) => {
      const element = document.querySelector(selector);
      if (element === null) throw new Error(`no ${selector}`);
      return { element, style: getComputedStyle(element) };
    };
    const cell = style('[data-slot="data-table"] td');
    const card = style('[data-slot="section"][data-variant="card"]');
    return {
      cellHeight: cell.element.getBoundingClientRect().height,
      cellPaddingTop: parseFloat(cell.style.paddingTop),
      listItemPaddingTop: parseFloat(style('[data-slot="list-item"]').style.paddingTop),
      sectionGap: parseFloat(card.style.rowGap),
      cardPadding: parseFloat(card.style.paddingTop),
      cardRadius: parseFloat(card.style.borderTopLeftRadius),
    };
  });
}

test.describe("operator theme settings", () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test("without settings the page carries no data-theme-* and renders the teal defaults", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto("/_ui");
    expect(await attributes(page)).toEqual([null, null, null]);
    expect(await rootToken(page, "--primary")).toBe("oklch(0.52 0.1 195)");
    expect(await rootToken(page, "--radius")).toBe("0.5rem");
  });

  for (const [mode, primary] of [
    ["light", "oklch(0.52 0.17 290)"],
    ["dark", "oklch(0.74 0.13 290)"],
  ] as const) {
    test(`a preset re-points the tokens in ${mode} mode`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: mode });
      await withBootTheme(page, { preset: "violet" });
      await page.goto("/_ui");
      expect(await attributes(page)).toEqual(["violet", null, null]);
      expect(await rootToken(page, "--primary")).toBe(primary);
      // Status tones do not move with an accent preset.
      expect(await rootToken(page, "--status-ok-fg")).toBe(mode === "light" ? "oklch(0.5 0.13 150)" : "oklch(0.76 0.15 150)");
    });
  }

  test("high-contrast darkens text in light mode", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await withBootTheme(page, { preset: "high-contrast" });
    await page.goto("/_ui");
    expect(await rootToken(page, "--foreground")).toBe("oklch(0.1 0 0)");
    expect(await rootToken(page, "--muted-foreground")).toBe("oklch(0.36 0 0)");
  });

  test("compact density tightens DataTable, List and Section, and radius rescales corners", async ({ page }) => {
    await page.goto("/_ui");
    const comfortable = await spacing(page);

    await withBootTheme(page, { density: "compact", radius: "lg" });
    await page.reload();
    expect(await attributes(page)).toEqual([null, "compact", "lg"]);
    const compact = await spacing(page);

    expect(compact.cellHeight).toBeLessThan(comfortable.cellHeight);
    expect(compact.cellPaddingTop).toBeLessThan(comfortable.cellPaddingTop);
    expect(compact.listItemPaddingTop).toBeLessThan(comfortable.listItemPaddingTop);
    expect(compact.sectionGap).toBeLessThan(comfortable.sectionGap);
    // At 1280px a card section is md:p-6 (24px), and md:p-4 (16px) under compact.
    expect(comfortable.cardPadding).toBe(24);
    expect(compact.cardPadding).toBe(16);
    // rounded-xl is --radius + 4px: 12px at the default md, 16px at lg.
    expect(comfortable.cardRadius).toBe(12);
    expect(compact.cardRadius).toBe(16);
  });
});
