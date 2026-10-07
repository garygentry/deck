import type { ModuleManifest } from "./manifest.js";

/**
 * A module's web half: a table of components that the manifest's pages, extensions and
 * widget types name. Where each one renders is data (manifest defaults, config overrides).
 */
export interface WebModule<Components extends Record<string, unknown> = Record<string, unknown>> {
  readonly manifest: ModuleManifest;
  readonly components: Readonly<Components>;
}

export function defineWebModule<Components extends Record<string, unknown>>(
  manifest: ModuleManifest,
  parts: { components: Components },
): WebModule<Components> {
  return Object.freeze({ manifest, components: Object.freeze({ ...parts.components }) });
}
