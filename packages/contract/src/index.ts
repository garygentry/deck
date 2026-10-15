/**
 * The wire contract the server serves and the web reads: provider envelopes and freshness,
 * the default poll timing and the boot payload (the snapshot provider's payload is the snapshot
 * module's, in `modules/snapshot/contract.ts`). It loads no server code, so
 * the browser bundle can import it at runtime.
 */
export {
  BOOT_ELEMENT_ID, deckBootTheme, readDeckBoot, readStyleNonce, serializeDeckBoot, STYLE_NONCE_PROPERTY, THEME_DENSITIES, THEME_MODES, THEME_PRESETS, THEME_RADII,
} from "./boot.js";
export type { DeckBoot, DeckBootTheme, ThemeDensity, ThemeMode, ThemePreset, ThemeRadius } from "./boot.js";
export type { FreshnessStamp, FreshnessState, ProviderEnvelope, ProviderProjection } from "./freshness.js";
export { POLL_DEFAULTS } from "./poll.js";
