import type { Page } from "@playwright/test";
import { THEME_CHOICE_KEY } from "../../src/shell/theme-chain.js";

/** Start every document of the page in `mode`, as the viewer's choice from the theme menu would. */
export async function seedTheme(page: Page, mode: string): Promise<void> {
  await page.addInitScript(([key, value]) => localStorage.setItem(key!, value!), [THEME_CHOICE_KEY, mode]);
}
