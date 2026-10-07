import type { UiManifest } from "@deck/module-sdk";
import type { UiManifestState } from "../data/index.js";
import type { PageRegistration } from "../registry/registry-types.js";
import { NAV_SLOT } from "../registry/registry.js";

/**
 * The built-in nav groups for the fallback nav only (the manifest cannot be read), in the
 * order the server's default ui config gives them. With a manifest, the manifest decides.
 */
const FALLBACK_GROUPS: readonly { id: string; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "inventory", label: "Inventory" },
  { id: "health", label: "Health" },
  { id: "operate", label: "Operate" },
  { id: "knowledge", label: "Knowledge" },
];

/**
 * The built-in group a page's `group` names: by id (a page registered through
 * `registerWebModule` carries its manifest group id), or by label. The label match serves
 * pages still registered with `registerPage` and a group heading; it is removed once every
 * built-in feature registers through `registerWebModule`.
 */
function fallbackGroup(group: string): { id: string; label: string } | undefined {
  return FALLBACK_GROUPS.find(({ id }) => id === group) ?? FALLBACK_GROUPS.find(({ label }) => label === group);
}

/** One sidebar link. */
export interface NavLink {
  id: string;
  label: string;
  icon: string | undefined;
  /** An in-app path, or an external `http(s):` URL. */
  href: string;
}

export interface NavGroup {
  /** The group id; `undefined` for pages registered without a group. */
  id: string | undefined;
  /** The group heading; `undefined` for the ungrouped links. */
  label: string | undefined;
  links: NavLink[];
}

/**
 * The sidebar navigation. The UI manifest decides it: its groups in order with their labels,
 * and in each its entries with their labels and icons. An entry to a page the web does not
 * route is left out. Until the manifest loads there is none; if it cannot be read, the
 * registered pages are listed instead ({@link groupNavPages}), so the app stays navigable.
 */
export function resolveNav(manifest: UiManifestState, pages: readonly PageRegistration[]): NavGroup[] {
  if (manifest.status === "loading") return [];
  if (manifest.status === "error" || !Array.isArray(manifest.manifest.nav)) return groupNavPages(pages);
  return navFromManifest(manifest.manifest, pages);
}

function navFromManifest(manifest: UiManifest, pages: readonly PageRegistration[]): NavGroup[] {
  const routed = new Map(pages.map((page) => [page.id as string, page]));
  const links = new Map<string, NavLink[]>();
  for (const item of manifest.nav) {
    if (item.slot !== NAV_SLOT) continue;
    const page = item.page === undefined ? undefined : routed.get(item.page);
    const href = item.page === undefined ? item.href : page?.path;
    if (href === undefined) continue;
    const list = links.get(item.group) ?? [];
    // A server that sends no label (version skew): the routed page's label, else the id.
    list.push({ id: item.id, label: item.label ?? page?.label ?? item.id, icon: item.icon ?? page?.icon, href });
    links.set(item.group, list);
  }
  // A manifest without groups (an older server) heads each group by its id, in entry order.
  const groups = Array.isArray(manifest.navGroups)
    ? manifest.navGroups
    : [...links.keys()].map((id) => ({ id, label: id }));
  return groups.flatMap(({ id, label }) => {
    const list = links.get(id);
    return list === undefined ? [] : [{ id, label, links: list }];
  });
}

/**
 * The fallback navigation, from the page registry alone: the navigable pages (nav !== false)
 * grouped by their `group`, each keeping registry order. The built-in groups come first, in
 * their default order, then any other group alphabetically; ungrouped pages come last, under
 * no heading.
 */
export function groupNavPages(pages: readonly PageRegistration[]): NavGroup[] {
  const groups = new Map<string | undefined, { label: string | undefined; links: NavLink[] }>();
  for (const page of pages) {
    if (page.nav === false) continue;
    const known = page.group === undefined ? undefined : fallbackGroup(page.group);
    const id = known?.id ?? page.group;
    const group = groups.get(id) ?? { label: known?.label ?? page.group, links: [] };
    group.links.push({ id: page.id, label: page.label, icon: page.icon, href: page.path });
    groups.set(id, group);
  }
  const rank = (id: string | undefined): [number, string] => {
    if (id === undefined) return [2, ""];
    const known = FALLBACK_GROUPS.findIndex((group) => group.id === id);
    return known === -1 ? [1, id] : [0, String(known).padStart(3, "0")];
  };
  return [...groups.entries()]
    .sort(([a], [b]) => {
      const [ra, ka] = rank(a);
      const [rb, kb] = rank(b);
      return ra - rb || (ka < kb ? -1 : ka > kb ? 1 : 0);
    })
    .map(([id, { label, links }]) => ({ id, label, links }));
}

/**
 * Whether a nav item is the current section: its own path, or any route below it
 * (`/hosts/nas-01` keeps Hosts active). The root only matches itself.
 */
export function isNavActive(itemPath: string, currentPath: string): boolean {
  if (itemPath === "/") return currentPath === "/";
  return currentPath === itemPath || currentPath.startsWith(`${itemPath}/`);
}

function patternMatches(pattern: string, path: string): boolean {
  const want = pattern.split("/").filter(Boolean);
  const have = path.split("/").filter(Boolean);
  return (
    want.length === have.length &&
    want.every((segment, i) => segment.startsWith(":") || segment === have[i])
  );
}

/** The page the router renders for `path`: the first route whose pattern matches. */
export function matchPage<T extends { path: string }>(pages: readonly T[], path: string): T | undefined {
  return pages.find((page) => patternMatches(page.path, path));
}
