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

/**
 * A runtime module's CSS prefix: its id lowercased, with every character that is not a letter
 * removed (Tailwind prefixes are letters only), as in `@import "@deck/sdk/tailwind" prefix(…)`.
 * `hello-world` → `helloworld`, `hello2` → `hello`. Its classes are its own only while no other
 * runtime module shares the prefix, so deck refuses a second module with the same one.
 */
export function modulePrefix(id: string): string {
  return id.toLowerCase().replace(/[^a-z]/g, "");
}
