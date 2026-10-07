import { expect, test, type Page } from "@playwright/test";

/**
 * Theme switching: the `.dark` class on <html> selects the dark tokens in
 * theme.css. An inline script in index.html applies the stored preference (or
 * the OS preference under "system") before first paint, so the page never
 * flashes the wrong theme while the app bundle loads.
 */

const STORAGE_KEY = "deck-theme";

async function storePreference(page: Page, mode: string): Promise<void> {
  await page.addInitScript(
    ([key, value]) => localStorage.setItem(key!, value!),
    [STORAGE_KEY, mode],
  );
}

const isDark = (page: Page): Promise<boolean> =>
  page.evaluate(() => document.documentElement.classList.contains("dark"));

/** Load the document with the app bundle blocked: only the inline script runs. */
async function loadWithoutApp(page: Page): Promise<void> {
  await page.route("**/src/main.tsx", (route) => route.abort());
  await page.goto("/", { waitUntil: "domcontentloaded" });
}

test.describe("pre-paint theme", () => {
  const cases = [
    { stored: null, system: "dark", dark: true },
    { stored: null, system: "light", dark: false },
    { stored: "system", system: "dark", dark: true },
    { stored: "dark", system: "light", dark: true },
    { stored: "light", system: "dark", dark: false },
  ] as const;

  for (const { stored, system, dark } of cases) {
    test(`stored=${stored ?? "none"}, OS=${system} → ${dark ? "dark" : "light"}`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme: system });
      if (stored) await storePreference(page, stored);
      await loadWithoutApp(page);
      expect(await isDark(page)).toBe(dark);
    });
  }
});

test("the theme menu switches light and dark and repaints the tokens", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/");
  const trigger = page.getByRole("button", { name: /^Theme: / });
  await expect(trigger).toHaveAccessibleName("Theme: system");
  const background = (): Promise<string> =>
    page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const choose = async (label: string): Promise<void> => {
    await trigger.click();
    await page.getByRole("menuitemradio", { name: label }).click();
  };

  // "system" under a dark OS.
  expect(await isDark(page)).toBe(true);
  const darkBackground = await background();

  await choose("Light");
  await expect(trigger).toHaveAccessibleName("Theme: light");
  expect(await isDark(page)).toBe(false);
  expect(await background()).not.toBe(darkBackground);
  expect(await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY)).toBe("light");

  await choose("Dark");
  await expect(trigger).toHaveAccessibleName("Theme: dark");
  expect(await isDark(page)).toBe(true);
  expect(await background()).toBe(darkBackground);
});
