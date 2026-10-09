import type { UiTheme } from "@deck/schema";

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
  /** The operator's theme defaults (`ui.theme`); a viewer's stored choice still wins for `mode`. */
  theme: DeckBootTheme;
  /**
   * The id of the page `/` renders (the UI manifest's `home.page`), or `null` when no page can
   * be home; the shell routes `/` by it while `/api/ui` loads, so a configured home page never
   * flashes the portal first. Absent when the server resolved no UI manifest.
   */
  home?: string | null;
  /**
   * The origins the page's Content-Security-Policy lets it frame (`frame-src`): those of the
   * `core/embed` widgets the manifest held when the page was served. A widget whose origin a
   * `ui` hot reload added later asks for a reload instead of showing a refused frame. Absent
   * when the page carries no policy (the dev server).
   */
  frameOrigins?: string[];
}

/**
 * The operator's theme settings, each absent when not configured. The pre-paint script sets the
 * three appearance settings on `<html>` as `data-theme-preset`, `data-theme-density` and
 * `data-theme-radius`; the preset, radius and density tokens in `theme.css` key off them.
 */
export interface DeckBootTheme {
  mode?: ThemeMode;
  preset?: ThemePreset;
  density?: ThemeDensity;
  radius?: ThemeRadius;
}

export type ThemeMode = NonNullable<UiTheme["mode"]>;
export type ThemePreset = NonNullable<UiTheme["preset"]>;
export type ThemeDensity = NonNullable<UiTheme["density"]>;
export type ThemeRadius = NonNullable<UiTheme["radius"]>;

/** Every value the `ui.theme` schema accepts, default first. */
export const THEME_MODES = ["system", "light", "dark"] as const satisfies readonly ThemeMode[];
export const THEME_PRESETS = ["teal", "slate", "copper", "rose", "high-contrast"] as const satisfies readonly ThemePreset[];
export const THEME_DENSITIES = ["comfortable", "compact"] as const satisfies readonly ThemeDensity[];
export const THEME_RADII = ["md", "none", "sm", "lg"] as const satisfies readonly ThemeRadius[];

// Each list names every schema value: a value the schema gains and a list lacks fails here.
type Missing<All, Listed> = Exclude<All, Listed> extends never ? true : Exclude<All, Listed>;
const listsAreComplete: [
  Missing<ThemeMode, (typeof THEME_MODES)[number]>,
  Missing<ThemePreset, (typeof THEME_PRESETS)[number]>,
  Missing<ThemeDensity, (typeof THEME_DENSITIES)[number]>,
  Missing<ThemeRadius, (typeof THEME_RADII)[number]>,
] = [true, true, true, true];
void listsAreComplete;

/** The id of the `<script type="application/json">` element carrying the boot object. */
export const BOOT_ELEMENT_ID = "deck-boot";

/**
 * The boot object in a document, read leniently: a missing or empty element (the dev server),
 * unparsable JSON or a malformed field gives the field's default (absent).
 */
export function readDeckBoot(doc: { getElementById(id: string): { textContent: string | null } | null }): {
  brand?: { title: string };
  theme: DeckBootTheme;
  /** Absent when the page carries no boot object (the dev server) or no valid `home`. */
  home?: string | null;
  /** Absent when the page carries no boot object (the dev server) or no valid list. */
  frameOrigins?: string[];
} {
  let value: unknown;
  try {
    value = JSON.parse(doc.getElementById(BOOT_ELEMENT_ID)?.textContent ?? "");
  } catch {
    value = undefined;
  }
  const boot = (typeof value === "object" && value !== null ? value : {}) as { brand?: { title?: unknown }; theme?: unknown; home?: unknown; frameOrigins?: unknown };
  const title = boot.brand?.title;
  const home = boot.home;
  const frameOrigins = boot.frameOrigins;
  return {
    ...(typeof title === "string" && title.trim() !== "" ? { brand: { title } } : {}),
    theme: deckBootTheme(boot.theme),
    ...(home === null || (typeof home === "string" && home !== "") ? { home } : {}),
    ...(Array.isArray(frameOrigins) && frameOrigins.every((origin) => typeof origin === "string") ? { frameOrigins: frameOrigins as string[] } : {}),
  };
}

/**
 * The known theme settings of a `ui.theme`-shaped value: each of `mode`, `preset`, `density`
 * and `radius` that holds a value the schema accepts, and nothing else.
 */
export function deckBootTheme(theme: unknown): DeckBootTheme {
  const source = (typeof theme === "object" && theme !== null ? theme : {}) as Record<string, unknown>;
  const pick = <T extends string>(values: readonly T[], value: unknown): T | undefined =>
    values.find((known) => known === value);
  const mode = pick(THEME_MODES, source.mode);
  const preset = pick(THEME_PRESETS, source.preset);
  const density = pick(THEME_DENSITIES, source.density);
  const radius = pick(THEME_RADII, source.radius);
  return {
    ...(mode !== undefined ? { mode } : {}),
    ...(preset !== undefined ? { preset } : {}),
    ...(density !== undefined ? { density } : {}),
    ...(radius !== undefined ? { radius } : {}),
  };
}

/**
 * The boot object as the text of its script element: JSON with `<`, `>`, `&` and the line
 * separators escaped, so no value can close the element or start markup.
 */
export function serializeDeckBoot(boot: DeckBoot): string {
  return JSON.stringify(boot).replace(/[<>&\u2028\u2029]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}
