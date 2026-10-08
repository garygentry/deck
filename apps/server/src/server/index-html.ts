import { BOOT_ELEMENT_ID, serializeDeckBoot, type DeckBoot, type ThemeMode } from "@deck/contract";
import type { UiManifest } from "@deck/module-sdk";

/** The brand title when no UI manifest was resolved. */
const DEFAULT_TITLE = "Deck";

const THEME_MODES: readonly string[] = ["light", "dark", "system"];

/** The empty boot element the built `index.html` carries, which the server fills. */
const BOOT_PLACEHOLDER = `<script type="application/json" id="${BOOT_ELEMENT_ID}"></script>`;

/**
 * The boot object for the current UI manifest and config: the brand title, the operator's
 * default theme mode (`ui.theme.mode`) and the home page's id. See `DeckBoot` for the
 * channel's contract.
 */
export function deckBootOf(manifest: UiManifest | undefined, config: unknown): DeckBoot {
  const mode = (config as { ui?: { theme?: { mode?: unknown } } } | null)?.ui?.theme?.mode;
  return {
    bootApi: 1,
    brand: { title: manifest?.brand.title ?? DEFAULT_TITLE },
    theme: typeof mode === "string" && THEME_MODES.includes(mode) ? { mode: mode as ThemeMode } : {},
    ...(manifest === undefined ? {} : { home: manifest.home?.page ?? null }),
  };
}

/**
 * The web shell's `index.html` with the boot object written in: its `<title>` is the brand
 * title, and the empty boot element carries {@link deckBootOf}. A template without them (a
 * build that predates the channel) is served with only what it has.
 */
export function renderIndexHtml(template: string, boot: DeckBoot): string {
  return template
    .replace(/<title>[^<]*<\/title>/, () => `<title>${escapeHtml(boot.brand.title)}</title>`)
    .replace(BOOT_PLACEHOLDER, () => `<script type="application/json" id="${BOOT_ELEMENT_ID}">${serializeDeckBoot(boot)}</script>`);
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}
