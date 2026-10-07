import type { UiManifest, UiModuleSwitch } from "@deck/module-sdk";
import type { UiManifestState } from "../data/index.js";
import type { PageRegistration } from "../registry/registry-types.js";

/** A path that belongs to a page of a disabled module: the shell says the module is off. */
export interface NotEnabledRoute {
  id: string;
  path: string;
  /** The page's title, for the heading and the document title. */
  label: string;
  /** The page's module id, as the manifest lists it. */
  module: string;
  /** The settings that would enable the module (names only); empty when none would. */
  enabledBy: readonly UiModuleSwitch[];
  /** Why the module is off, as the manifest says; absent if it does not. */
  reason: string | undefined;
}

export interface ResolvedRoutes {
  /** The registered pages the router renders. */
  routed: readonly PageRegistration[];
  /** Paths of disabled modules' pages, matched after the routed pages. */
  notEnabled: readonly NotEnabledRoute[];
}

/**
 * Which pages the router renders. With the UI manifest, a registered page the manifest lists
 * as a disabled page is not routed, and every disabled page answers its path with the
 * not-enabled page. A page is only ever dropped for such a replacement: until the manifest
 * loads, if it cannot be read, or if it lists no disabled pages (an older server), every
 * registered page is routed, as the fallback nav lists them all.
 */
export function resolveRoutes(manifest: UiManifestState, pages: readonly PageRegistration[]): ResolvedRoutes {
  if (manifest.status !== "ready" || !Array.isArray(manifest.manifest.disabledPages)) return { routed: pages, notEnabled: [] };
  return routesFromManifest(manifest.manifest, manifest.manifest.disabledPages, pages);
}

function routesFromManifest(
  manifest: UiManifest,
  disabledPages: NonNullable<UiManifest["disabledPages"]>,
  pages: readonly PageRegistration[],
): ResolvedRoutes {
  const modules = new Map((Array.isArray(manifest.modules) ? manifest.modules : []).map((module) => [module.id, module]));
  const disabledIds = new Set<string>(disabledPages.map((page) => page.id));
  return {
    routed: pages.filter((page) => !disabledIds.has(page.id)),
    notEnabled: disabledPages.map((page) => {
      const module = modules.get(page.module);
      return {
        id: page.id,
        path: page.path,
        label: page.title,
        module: page.module,
        enabledBy: moduleSwitches(module?.enabledBy),
        reason: module?.reason,
      };
    }),
  };
}

/**
 * A module's switches, read leniently: an entry is kept when it names an env var or a config
 * key (other keys are ignored), anything else is dropped. A malformed value only loses the hint.
 */
export function moduleSwitches(value: unknown): UiModuleSwitch[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): UiModuleSwitch[] => {
    if (typeof entry !== "object" || entry === null) return [];
    const { env, config } = entry as { env?: unknown; config?: unknown };
    if (typeof env === "string" && env !== "") return [{ env }];
    if (typeof config === "string" && config !== "") return [{ config }];
    return [];
  });
}
