/**
 * Pure URL and tree-lookup helpers for the source browser, shared by the Docs/Configs page and
 * the owned-configs entity fragment (which must not import the page module).
 */

import type { SourceTreeNode } from "../server/types.js";

/** Stable deep link to one source (+ optional file) on a browser route. Reserved chars round-trip. */
export function sourceHref(route: string, sourceId: string, path?: string): string {
  const params = new URLSearchParams();
  params.set("source", sourceId);
  if (path !== undefined && path !== "") params.set("path", path);
  return `${route}?${params.toString()}`;
}

/** Stable `/configs` deep link for one source (+ optional file). Reserved chars round-trip. */
export function configsHref(sourceId: string, path?: string): string {
  return sourceHref("/configs", sourceId, path);
}

/** Depth-first lookup of one file/dir node by POSIX path; null when absent. Pure. */
export function findNode(root: SourceTreeNode, path: string): SourceTreeNode | null {
  if (root.path === path) return root;
  for (const child of root.children ?? []) {
    const hit = findNode(child, path);
    if (hit !== null) return hit;
  }
  return null;
}

/**
 * The path whose content should be loaded for the current selection, or null. A binary file (or a
 * dir, or an absent node) yields null so the page never fetches its content as text.
 */
export function fileLoadPath(node: SourceTreeNode | null, path: string | null): string | null {
  if (node === null || path === null) return null;
  if (node.type !== "file" || node.binary === true) return null;
  return path;
}
