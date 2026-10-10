import { DEFAULT_HOME_PAGE, homePathProblem, parseExtensionId, type UiManifest, type UiModuleSwitch } from "@deck/module-sdk";
import type { UiManifestState } from "../data/index.js";
import type { PageRegistration } from "../registry/registry-types.js";
import { matchPage } from "./nav.js";

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
  /** The page `/` renders (it also stays routed at its own path); none when no page can be home. */
  home: PageRegistration | undefined;
  /** The registered pages the router renders. */
  routed: readonly PageRegistration[];
  /** Paths of disabled modules' pages, matched after the routed pages. */
  notEnabled: readonly NotEnabledRoute[];
}

/**
 * Which pages the router renders. With a current UI manifest (one listing `disabledPages`), a
 * registered page of a module it lists is routed only if the manifest routes it (lists it in
 * `pages`): so a page of a disabled module, a page an override switches off and a page that
 * lost its path are not, and none can shadow another on its path. Each disabled page it lists
 * answers its path with the not-enabled page. Pages of modules it does not list (the `_ui`
 * workbench) are routed. Until the manifest loads, if it cannot be read, or if it is an older
 * server's (no `disabledPages`), every registered page is routed, as the fallback nav lists
 * them all. `bootHome` is the home page id the server wrote into the page (see
 * {@link resolveHome}).
 */
export function resolveRoutes(
  manifest: UiManifestState,
  pages: readonly PageRegistration[],
  bootHome?: string | null,
): ResolvedRoutes {
  const routes =
    manifest.status !== "ready" || !Array.isArray(manifest.manifest.disabledPages)
      ? { routed: pages, notEnabled: [] }
      : routesFromManifest(manifest.manifest, manifest.manifest.disabledPages, pages);
  return { home: resolveHome(manifest, routes.routed, bootHome), ...routes };
}

/**
 * The page `/` renders, chosen by id, never by which page happens to share a path:
 * - with a manifest that names it, its `home` (`null`: no page can be home), when the web
 *   routes it;
 * - otherwise (no manifest yet, none readable, or an older server's), the home page id the
 *   server wrote into the page's boot object, so a configured home never flashes the portal
 *   first (`null` there also means none);
 * - otherwise (no boot object, as under the dev server), the default home page, the portal's
 *   overview.
 * A page whose path has parameters cannot be home.
 */
export function resolveHome(
  manifest: UiManifestState,
  routed: readonly PageRegistration[],
  bootHome?: string | null,
): PageRegistration | undefined {
  const usable = (id: unknown): PageRegistration | undefined => {
    const page = routed.find((candidate) => candidate.id === id);
    return page !== undefined && homePathProblem(page.path) === null ? page : undefined;
  };
  if (manifest.status === "ready" && manifest.manifest.home !== undefined) {
    return manifest.manifest.home === null ? undefined : usable(manifest.manifest.home.page);
  }
  if (bootHome === null) return undefined;
  return (bootHome === undefined ? undefined : usable(bootHome)) ?? usable(DEFAULT_HOME_PAGE);
}

/**
 * The page the router renders for `path`, for the title and the current nav entry: the home
 * page at `/`, else the first routed page whose pattern matches, else a disabled module's page.
 */
export function routeForPath(routes: ResolvedRoutes, path: string): { id: string; label: string } | undefined {
  if (path === HOME_PATH) return routes.home;
  return matchPage(routes.routed, path) ?? matchPage(routes.notEnabled, path);
}

/**
 * What the top bar and the document title call a page: the label of its nav entry in the UI
 * manifest (a config page's `nav.label`, when it relabels the page), else the manifest's title
 * for the page, else the label it registered with. So a page reads the same in the sidebar, the
 * top bar and the browser tab. Read leniently: a malformed entry is passed over.
 */
export function routeLabel(manifest: UiManifestState, route: { id: string; label: string }): string {
  if (manifest.status !== "ready") return route.label;
  const { nav, pages } = manifest.manifest;
  const entry = Array.isArray(nav) ? nav.find((item) => item?.page === route.id && item.separator !== true && typeof item.label === "string" && item.label.trim() !== "") : undefined;
  if (entry !== undefined) return entry.label;
  const page = Array.isArray(pages) ? pages.find((candidate) => candidate?.id === route.id) : undefined;
  return typeof page?.title === "string" && page.title.trim() !== "" ? page.title : route.label;
}

/** The path that renders the home page. */
export const HOME_PATH = "/";

function routesFromManifest(
  manifest: UiManifest,
  disabledPages: NonNullable<UiManifest["disabledPages"]>,
  pages: readonly PageRegistration[],
): Omit<ResolvedRoutes, "home"> {
  const modules = new Map((Array.isArray(manifest.modules) ? manifest.modules : []).map((module) => [module.id, module]));
  const disabledIds = new Set<string>(disabledPages.map((page) => page.id));
  // Absent (a manifest without `pages`): no narrowing beyond the disabled modules.
  const routedIds = Array.isArray(manifest.pages) ? new Set<string>(manifest.pages.map((page) => page.id)) : undefined;
  const isOff = (page: PageRegistration): boolean => {
    const module = parseExtensionId(page.id)?.module;
    if (disabledIds.has(page.id)) return true;
    if (module === undefined || !modules.has(module)) return false;
    // A page of a module the manifest lists is routed only where the manifest routes it.
    return modules.get(module)?.enabled === false || (routedIds !== undefined && !routedIds.has(page.id));
  };
  return {
    routed: pages.filter((page) => !isOff(page)),
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
