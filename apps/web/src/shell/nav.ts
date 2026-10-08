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

/** The built-in group a page's `group` names, by its manifest group id. */
function fallbackGroup(group: string): { id: string; label: string } | undefined {
  return FALLBACK_GROUPS.find(({ id }) => id === group);
}

/** One sidebar link. */
export interface NavLink {
  id: string;
  label: string;
  icon: string | undefined;
  /** An in-app path, or an external `http(s):` URL. */
  href: string;
  /** An external `http(s):` URL: it opens in a new tab and is never the current section. */
  external?: true;
  /** The home page's own path, which also marks its link (to `/`) current. */
  alsoActiveOn?: string;
}

/** A rule between a group's links. */
export interface NavSeparator {
  id: string;
  separator: true;
}

export type NavEntry = NavLink | NavSeparator;

export interface NavGroup<E extends NavEntry = NavEntry> {
  /** The group id; `undefined` for pages registered without a group. */
  id: string | undefined;
  /** The group heading; `undefined` for the ungrouped links. */
  label: string | undefined;
  /** An icon shown beside the heading. */
  icon?: string;
  links: E[];
}

/** Whether a nav entry is a separator rather than a link. */
export function isSeparator(entry: NavEntry): entry is NavSeparator {
  return "separator" in entry;
}

/** An external link the sidebar opens in a new tab. */
const EXTERNAL_HREF = /^https?:\/\//i;
/** An in-app path: absolute, never protocol-relative. */
const APP_PATH = /^\/(?!\/)/;

/**
 * The sidebar navigation. The UI manifest decides it: its groups in order with their labels,
 * and in each its entries with their labels and icons. An entry to a page the web does not
 * route is left out. Until the manifest loads there is none; if it cannot be read, the
 * registered pages are listed instead ({@link groupNavPages}), so the app stays navigable.
 */
export function resolveNav(
  manifest: UiManifestState,
  pages: readonly PageRegistration[],
  home?: PageRegistration,
): NavGroup[] {
  if (manifest.status === "loading") return [];
  const groups =
    manifest.status === "error" || !Array.isArray(manifest.manifest.nav) ? groupNavPages(pages) : navFromManifest(manifest.manifest, pages);
  return home === undefined ? groups : groups.map((group) => ({ ...group, links: group.links.map((link) => linkHome(link, home)) }));
}

/** The home page's link goes to `/`, and stays current on its own path (and below it). */
function linkHome(link: NavEntry, home: PageRegistration): NavEntry {
  return !isSeparator(link) && link.external !== true && link.href === home.path && home.path !== "/"
    ? { ...link, href: "/", alsoActiveOn: home.path }
    : link;
}

/** A group's entries without a separator at either end or next to another. */
function trimSeparators(entries: readonly NavEntry[]): NavEntry[] {
  const kept: NavEntry[] = [];
  for (const entry of entries) {
    if (isSeparator(entry) && (kept.length === 0 || isSeparator(kept[kept.length - 1]!))) continue;
    kept.push(entry);
  }
  while (kept.length > 0 && isSeparator(kept[kept.length - 1]!)) kept.pop();
  return kept;
}

function navFromManifest(manifest: UiManifest, pages: readonly PageRegistration[]): NavGroup[] {
  const routed = new Map(pages.map((page) => [page.id as string, page]));
  const links = new Map<string, NavEntry[]>();
  for (const item of manifest.nav) {
    if (item.slot !== NAV_SLOT) continue;
    const list = links.get(item.group) ?? [];
    links.set(item.group, list);
    if (item.separator === true) {
      list.push({ id: item.id, separator: true });
      continue;
    }
    const page = item.page === undefined ? undefined : routed.get(item.page);
    const href = item.page === undefined ? item.href : page?.path;
    // Only an in-app path or an http(s) URL is a link (never `javascript:` and the like).
    if (href === undefined || !(APP_PATH.test(href) || EXTERNAL_HREF.test(href))) continue;
    // A server that sends no label (version skew): the routed page's label, else the id.
    list.push({
      id: item.id,
      label: item.label ?? page?.label ?? item.id,
      icon: item.icon ?? page?.icon,
      href,
      ...(EXTERNAL_HREF.test(href) ? { external: true as const } : {}),
    });
  }
  // A manifest without groups (an older server) heads each group by its id, in entry order.
  const groups: readonly { id: string; label: string; icon?: string }[] = Array.isArray(manifest.navGroups)
    ? manifest.navGroups
    : [...links.keys()].map((id) => ({ id, label: id }));
  return groups.flatMap(({ id, label, icon }) => {
    const list = trimSeparators(links.get(id) ?? []);
    // A group of separators alone has nothing to show.
    if (!list.some((entry) => !isSeparator(entry))) return [];
    return [{ id, label, ...(typeof icon === "string" ? { icon } : {}), links: list }];
  });
}

/**
 * The fallback navigation, from the page registry alone: the navigable pages (nav !== false)
 * grouped by their `group`, each in nav order (`navOrder`, else the page's order, then registry
 * order). The built-in groups come first, in their default order, then any other group
 * alphabetically; ungrouped pages come last, under no heading.
 */
export function groupNavPages(pages: readonly PageRegistration[]): NavGroup<NavLink>[] {
  const groups = new Map<string | undefined, { label: string | undefined; links: NavLink[] }>();
  // By each page's nav order (stable, so equal orders keep registry order); routes keep theirs.
  const navOrder = (page: PageRegistration) => page.navOrder ?? page.order ?? 100;
  for (const page of [...pages].sort((a, b) => navOrder(a) - navOrder(b))) {
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

/** Whether a nav link is the current section: by its path, or by the home page's own path. */
export function isLinkActive(link: Pick<NavLink, "href" | "alsoActiveOn" | "external">, currentPath: string): boolean {
  if (link.external === true) return false;
  return isNavActive(link.href, currentPath) || (link.alsoActiveOn !== undefined && isNavActive(link.alsoActiveOn, currentPath));
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
