import type { UiManifest, UiModule } from "@deck/module-sdk";
import type { UiManifestState } from "../data/index.js";
import type { PageRegistration } from "../registry/registry-types.js";

/** A path that belongs to a page of a disabled module: the shell says the module is off. */
export interface NotEnabledRoute {
  id: string;
  path: string;
  /** The page's title, for the heading and the document title. */
  label: string;
  /** The module, as the manifest lists it (with why it is off); absent if it does not. */
  module: UiModule | undefined;
}

export interface ResolvedRoutes {
  /** The registered pages the router renders. */
  routed: readonly PageRegistration[];
  /** Paths of disabled modules' pages, matched after the routed pages. */
  notEnabled: readonly NotEnabledRoute[];
}

/**
 * Which pages the router renders. With the UI manifest, a registered page of a module the
 * manifest lists as disabled is not routed, and every page the manifest lists as disabled
 * answers its path with the not-enabled page. Until the manifest loads, or if it cannot be
 * read, every registered page is routed, as the fallback nav lists them all. Pages the
 * manifest never declares (the `_ui` workbench) are routed either way.
 */
export function resolveRoutes(manifest: UiManifestState, pages: readonly PageRegistration[]): ResolvedRoutes {
  if (manifest.status !== "ready") return { routed: pages, notEnabled: [] };
  return routesFromManifest(manifest.manifest, pages);
}

function routesFromManifest(manifest: UiManifest, pages: readonly PageRegistration[]): ResolvedRoutes {
  // An older server sends neither list; a module it does not list is not known to be off.
  const modules = new Map((Array.isArray(manifest.modules) ? manifest.modules : []).map((module) => [module.id, module]));
  const disabledPages = Array.isArray(manifest.disabledPages) ? manifest.disabledPages : [];
  const disabledIds = new Set<string>(disabledPages.map((page) => page.id));
  const isOff = (page: PageRegistration): boolean =>
    disabledIds.has(page.id) || modules.get(moduleOf(page.id))?.enabled === false;
  return {
    routed: pages.filter((page) => !isOff(page)),
    notEnabled: disabledPages.map((page) => ({
      id: page.id,
      path: page.path,
      label: page.title,
      module: modules.get(page.module),
    })),
  };
}

/** The module segment of an extension id (`page:<module>/<name>`). */
function moduleOf(id: string): string {
  return id.slice(id.indexOf(":") + 1, id.indexOf("/"));
}
