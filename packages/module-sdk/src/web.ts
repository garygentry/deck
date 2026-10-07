import type { ModuleManifest } from "./manifest.js";

/**
 * The part of a manifest the web half reads: the module's identity and its UI contributions
 * (pages, nav entries, slots, extensions). A full {@link ModuleManifest} is one too, so an
 * external module passes its whole manifest; a built-in shares just this part with the web.
 */
export type WebModuleManifest = Pick<ModuleManifest, "id" | "version" | "deckApi" | "contributes">;

/**
 * A module's web half: a table of components that the manifest's pages, extensions and
 * widget types name. Where each one renders is data (manifest defaults, config overrides).
 */
export interface WebModule<Components extends Record<string, unknown> = Record<string, unknown>> {
  readonly manifest: WebModuleManifest;
  readonly components: Readonly<Components>;
}

export function defineWebModule<Components extends Record<string, unknown>>(
  manifest: WebModuleManifest,
  parts: { components: Components },
): WebModule<Components> {
  return Object.freeze({ manifest, components: Object.freeze({ ...parts.components }) });
}
