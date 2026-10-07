/**
 * Fixtures for the source-browser (Docs / Configs) render tests.
 *
 * The page drives its loads through `use-source`'s load hooks; render tests mock those out (keeping
 * the store subscription) and prime the singleton browse store directly, so every
 * envelope/file/search state renders deterministically without a network.
 */
import type { FreshnessState, ProviderEnvelope } from "@deck/contract";
import type { DeckConfig } from "@deck/server";
import type { SourceKind, SourceManifest, SourceTreeNode } from "@deck/server/sources";

export function fileNode(path: string, binary = false): SourceTreeNode {
  return { path, name: path.split("/").pop() ?? path, type: "file", size: 16, binary };
}

export function dirNode(path: string, children: SourceTreeNode[]): SourceTreeNode {
  return { path, name: path.split("/").pop() ?? path, type: "dir", children };
}

function countFiles(nodes: readonly SourceTreeNode[]): number {
  return nodes.reduce(
    (n, node) => n + (node.type === "file" ? 1 : countFiles(node.children ?? [])),
    0,
  );
}

export function manifest(
  sourceId: string,
  kind: SourceKind,
  children: SourceTreeNode[],
): SourceManifest {
  return {
    sourceId,
    kind,
    title: sourceId,
    fileCount: countFiles(children),
    tree: { path: "", name: "", type: "dir", children },
  };
}

export function envelope(
  sourceId: string,
  kind: SourceKind,
  data: SourceManifest | null,
  state: FreshnessState = "fresh",
  error: { message: string } | null = null,
): ProviderEnvelope<SourceManifest> {
  return {
    id: sourceId,
    kind,
    freshness: { state, observedAt: "2026-09-17T00:00:00.000Z", ageMs: 5_000, ttlMs: 30_000 },
    data,
    error,
  };
}

/** A config declaring `ids` of `kind`, plus one source of the other kind the page must ignore. */
export function sourcesConfig(kind: SourceKind, ...ids: string[]): DeckConfig {
  const otherKind: SourceKind = kind === "markdown-tree" ? "file-tree" : "markdown-tree";
  // The minimal shape the data layer accepts as an estate config document.
  return {
    schemaVersion: 2,
    estate: { name: "Test estate" },
    sources: [
      ...ids.map((id) => ({ id, kind, title: `Source ${id}`, location: { path: `/srv/${id}` } })),
      { id: "other", kind: otherKind, title: "Other", location: { path: "/srv/other" } },
    ],
  } as unknown as DeckConfig;
}
