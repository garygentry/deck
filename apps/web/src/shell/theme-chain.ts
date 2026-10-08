/**
 * The theme mode a page starts in, in one implementation shared by the pre-paint script in
 * `index.html` (inlined from this file's source by the Vite plugin in `vite.config.ts`) and by
 * `useThemeMode`. The chain:
 *
 * 1. the viewer's explicit choice, stored under {@link THEME_CHOICE_KEY} by the theme menu;
 * 2. a legacy `deck-theme` value of `light` or `dark`: an older shell stored the mode there on
 *    every load, so only those two were ever a choice (its `system` was the default, and is
 *    ignored so the operator's default can apply);
 * 3. the operator's default, `theme.mode` in the boot object the server writes into the page;
 * 4. `system`.
 */

/** Where the theme menu stores the viewer's explicit choice. */
export const THEME_CHOICE_KEY = "deck-theme-choice";

/** Where an older shell stored the mode on every load (read for migration only). */
export const LEGACY_THEME_KEY = "deck-theme";

export type ThemeMode = "system" | "light" | "dark";

/**
 * The start mode from storage and the boot element's text. It is inlined into `index.html`
 * by its source text, so it must stay self-contained: no imports, no outer references, ES5
 * syntax only (the keys are literals; a test pins them to the exported constants).
 */
export function initialThemeMode(getItem: (key: string) => string | null, bootText: string | null | undefined): ThemeMode {
  var choice = null;
  try {
    choice = getItem("deck-theme-choice");
  } catch (e) {
    // Private mode / blocked storage: no stored choice.
  }
  if (choice === "light" || choice === "dark" || choice === "system") return choice;
  var legacy = null;
  try {
    legacy = getItem("deck-theme");
  } catch (e) {
    // As above.
  }
  if (legacy === "light" || legacy === "dark") return legacy;
  var mode = null;
  try {
    mode = JSON.parse(bootText || "null").theme.mode;
  } catch (e) {
    // No boot object (the Vite dev server) or a malformed one.
  }
  if (mode === "light" || mode === "dark" || mode === "system") return mode;
  return "system";
}

/** The marker in `index.html` the pre-paint script replaces. */
export const PRE_PAINT_MARKER = "<!-- deck:pre-paint-theme -->";

/**
 * The pre-paint script: apply {@link initialThemeMode} to `<html>` before first paint, so the
 * page never flashes the wrong theme. `shell/theme.ts` applies the same `.dark` class later.
 */
export function prePaintScript(): string {
  return [
    "<script>",
    "(function () {",
    `  var initialThemeMode = ${initialThemeMode.toString()};`,
    "  var boot = document.getElementById(\"deck-boot\");",
    "  var mode = initialThemeMode(function (key) { return localStorage.getItem(key); }, boot && boot.textContent);",
    "  var dark = mode === \"dark\" || (mode !== \"light\" && window.matchMedia(\"(prefers-color-scheme: dark)\").matches);",
    "  document.documentElement.classList.toggle(\"dark\", dark);",
    "})();",
    "</script>",
  ].join("\n");
}
