import type { ModuleContributions, ModuleManifest } from "./manifest.js";

/**
 * The part of a manifest the web half reads: the module's identity and its UI contributions
 * (pages, nav entries, slots, extensions). It has no `routes`, which are server-only: a
 * built-in's shared copy cannot declare them, so the server manifest that spreads it in owns
 * its routes alone. A full {@link ModuleManifest} value is still accepted where one is
 * expected, so an external module passes its whole manifest.
 */
export type WebModuleManifest = Pick<ModuleManifest, "id" | "version" | "deckApi"> & {
  contributes?: Omit<ModuleContributions, "routes">;
};

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
