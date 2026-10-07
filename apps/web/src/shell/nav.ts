import type { PageRegistration } from "../registry/registry-types.js";

/** Known navigation groups, in sidebar order. Unknown groups follow, alphabetically. */
export const NAV_GROUP_ORDER: readonly string[] = [
  "Overview",
  "Inventory",
  "Health",
  "Operate",
  "Knowledge",
];

export interface NavGroup {
  /** The group heading; `undefined` for pages registered without a group. */
  label: string | undefined;
  pages: PageRegistration[];
}

/**
 * Group the navigable pages (nav !== false) for the sidebar, keeping each group's
 * pages in registry order. Ungrouped pages come last, under no heading.
 */
export function groupNavPages(pages: readonly PageRegistration[]): NavGroup[] {
  const groups = new Map<string | undefined, PageRegistration[]>();
  for (const page of pages) {
    if (page.nav === false) continue;
    const list = groups.get(page.group) ?? [];
    list.push(page);
    groups.set(page.group, list);
  }
  const rank = (label: string | undefined): [number, string] => {
    if (label === undefined) return [2, ""];
    const known = NAV_GROUP_ORDER.indexOf(label);
    return known === -1 ? [1, label] : [0, String(known).padStart(3, "0")];
  };
  return [...groups.entries()]
    .sort(([a], [b]) => {
      const [ra, ka] = rank(a);
      const [rb, kb] = rank(b);
      return ra - rb || ka.localeCompare(kb);
    })
    .map(([label, list]) => ({ label, pages: list }));
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

/** The page the router renders for `path`: the first registration whose pattern matches. */
export function matchPage(
  pages: readonly PageRegistration[],
  path: string,
): PageRegistration | undefined {
  return pages.find((page) => patternMatches(page.path, path));
}
