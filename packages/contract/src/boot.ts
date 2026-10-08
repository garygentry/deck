/**
 * The boot channel: what the server writes into `index.html` for the shell to read before it
 * can fetch anything (the pre-paint theme script runs before any request). It is one JSON
 * object in `<script type="application/json" id="deck-boot">`, written from the current UI
 * manifest and `ui` config on every serve of the page. Under the Vite dev server nothing is
 * written, so every field has a default.
 *
 * This is the only boot channel: a new pre-paint setting (a theme preset, density) is a new
 * optional field here, read by the pre-paint script in `index.html` (which mirrors
 * {@link readDeckBoot}) and written by the server's index renderer.
 */
export interface DeckBoot {
  /** Version of this object's shape. */
  bootApi: 1;
  /** The brand title, which also fills the page's `<title>`. */
  brand: { title: string };
  /** The operator's theme defaults (`ui.theme`); a viewer's stored choice still wins. */
  theme: { mode?: ThemeMode };
  /**
   * The id of the page `/` renders (the UI manifest's `home.page`), or `null` when no page can
   * be home; the shell routes `/` by it while `/api/ui` loads, so a configured home page never
   * flashes the portal first. Absent when the server resolved no UI manifest.
   */
  home?: string | null;
}

export type ThemeMode = "light" | "dark" | "system";

/** The id of the `<script type="application/json">` element carrying the boot object. */
export const BOOT_ELEMENT_ID = "deck-boot";

const THEME_MODES: readonly string[] = ["light", "dark", "system"];

/**
 * The boot object in a document, read leniently: a missing or empty element (the dev server),
 * unparsable JSON or a malformed field gives the field's default (absent).
 */
export function readDeckBoot(doc: { getElementById(id: string): { textContent: string | null } | null }): {
  brand?: { title: string };
  theme: { mode?: ThemeMode };
  /** Absent when the page carries no boot object (the dev server) or no valid `home`. */
  home?: string | null;
} {
  let value: unknown;
  try {
    value = JSON.parse(doc.getElementById(BOOT_ELEMENT_ID)?.textContent ?? "");
  } catch {
    value = undefined;
  }
  const boot = (typeof value === "object" && value !== null ? value : {}) as { brand?: { title?: unknown }; theme?: { mode?: unknown }; home?: unknown };
  const title = boot.brand?.title;
  const mode = boot.theme?.mode;
  const home = boot.home;
  return {
    ...(typeof title === "string" && title.trim() !== "" ? { brand: { title } } : {}),
    theme: typeof mode === "string" && THEME_MODES.includes(mode) ? { mode: mode as ThemeMode } : {},
    ...(home === null || (typeof home === "string" && home !== "") ? { home } : {}),
  };
}

/**
 * The boot object as the text of its script element: JSON with `<`, `>`, `&` and the line
 * separators escaped, so no value can close the element or start markup.
 */
export function serializeDeckBoot(boot: DeckBoot): string {
  return JSON.stringify(boot).replace(/[<>&\u2028\u2029]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}
