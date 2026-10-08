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
 * Which pages the router renders. With a current UI manifest (one listing `disabledPages`), no
 * registered page of a module it lists as disabled is routed, so none can shadow an enabled
 * page on the same path; each disabled page it lists answers its path with the not-enabled
 * page. Until the manifest loads, if it cannot be read, or if it is an older server's (no
 * `disabledPages`), every registered page is routed, as the fallback nav lists them all.
 */
export function resolveRoutes(manifest: UiManifestState, pages: readonly PageRegistration[]): ResolvedRoutes {
  const routes =
    manifest.status !== "ready" || !Array.isArray(manifest.manifest.disabledPages)
      ? { routed: pages, notEnabled: [] }
      : routesFromManifest(manifest.manifest, manifest.manifest.disabledPages, pages);
  return { home: resolveHome(manifest, routes.routed), ...routes };
}

/**
 * The page `/` renders, chosen by id, never by which page happens to share a path: the
 * manifest's `home` when the web routes it, else (no manifest yet, none readable, or an
 * older server's) the default home page, the portal's overview. A page whose path has
 * parameters cannot be home.
 */
export function resolveHome(manifest: UiManifestState, routed: readonly PageRegistration[]): PageRegistration | undefined {
  const usable = (id: unknown): PageRegistration | undefined => {
    const page = routed.find((candidate) => candidate.id === id);
    return page !== undefined && homePathProblem(page.path) === null ? page : undefined;
  };
  if (manifest.status === "ready" && manifest.manifest.home !== undefined) {
    return usable(manifest.manifest.home.page);
  }
  return usable(DEFAULT_HOME_PAGE);
}

/**
 * The page the router renders for `path`, for the title and the current nav entry: the home
 * page at `/`, else the first routed page whose pattern matches, else a disabled module's page.
 */
export function routeForPath(routes: ResolvedRoutes, path: string): { label: string } | undefined {
  if (path === HOME_PATH) return routes.home;
  return matchPage(routes.routed, path) ?? matchPage(routes.notEnabled, path);
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
  const isOff = (page: PageRegistration): boolean => {
    const module = parseExtensionId(page.id)?.module;
    return disabledIds.has(page.id) || (module !== undefined && modules.get(module)?.enabled === false);
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
