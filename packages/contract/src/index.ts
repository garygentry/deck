/**
 * The wire contract the server serves and the web reads: provider envelopes and freshness,
 * the default poll timing, and the snapshot provider's payload. It loads no server code, so
 * the browser bundle can import it at runtime.
 */
export {
  BOOT_ELEMENT_ID, deckBootTheme, readDeckBoot, serializeDeckBoot, THEME_DENSITIES, THEME_MODES, THEME_PRESETS, THEME_RADII,
} from "./boot.js";
export type { DeckBoot, DeckBootTheme, ThemeDensity, ThemeMode, ThemePreset, ThemeRadius } from "./boot.js";
export type { FreshnessStamp, FreshnessState, ProviderEnvelope } from "./freshness.js";
export { POLL_DEFAULTS } from "./poll.js";
export type {
  HostCollectionState,
  HostState,
  SnapshotProviderResult,
  SnapshotReadError,
} from "./snapshot.js";
