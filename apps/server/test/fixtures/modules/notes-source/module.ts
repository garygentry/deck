/**
 * A fixture third-party module that serves one in-memory source, `notes`, through the
 * `sources` module's browsing routes. It imports only types from `@deck/module-sdk` (a plain
 * `{ manifest, init }` object, and a plain `{ name }` service handle), so it shows that the
 * `sources/reader` service is reachable through the public contract alone.
 */
import type { ModuleManifest, ServerModule, ServiceRef } from "@deck/module-sdk";

/** A tree node, structurally the sources module's `SourceTreeNode`. */
interface NoteNode {
  path: string;
  name: string;
  type: "dir" | "file";
  size?: number;
  children?: NoteNode[];
}

/** One source this module serves, structurally the sources module's `SourceStore`. */
export interface NotesStore {
  readonly id: string;
  readonly kind: "markdown-tree";
  buildManifest(): Promise<{ sourceId: string; kind: "markdown-tree"; title: string; fileCount: number; tree: NoteNode }>;
  readFile(path: string): Promise<{ path: string; size: number; truncated: boolean; binary: boolean; content?: string; language?: string }>;
  readRaw(path: string): Promise<{ path: string; contentType: string; bytes: Uint8Array }>;
  search(query: string): Promise<{ sourceId: string; query: string; matches: { path: string; kind: "name" | "content"; snippet?: string }[]; truncated: boolean }>;
}

/** Structurally the sources module's `SourceReader`, the `sources/reader` service. */
export interface NotesReader {
  get(id: string): NotesStore | undefined;
}

const SOURCE_READER: ServiceRef<NotesReader> = { name: "sources/reader" };

const NOTE = "# Notes\n\nKept by a third-party module.\n";

const notes: NotesStore = {
  id: "notes",
  kind: "markdown-tree",
  buildManifest: async () => ({
    sourceId: "notes",
    kind: "markdown-tree",
    title: "Notes",
    fileCount: 1,
    tree: { path: "", name: "", type: "dir", children: [{ path: "index.md", name: "index.md", type: "file", size: NOTE.length }] },
  }),
  readFile: async (path) => {
    if (path !== "index.md") throw Object.assign(new Error("not found"), { code: "ENOENT" });
    return { path, size: NOTE.length, truncated: false, binary: false, content: NOTE, language: "markdown" };
  },
  readRaw: async () => {
    throw new Error("notes has no images");
  },
  search: async (query) => ({
    sourceId: "notes",
    query,
    matches: NOTE.includes(query) ? [{ path: "index.md", kind: "content", snippet: NOTE.trim() }] : [],
    truncated: false,
  }),
};

export const NOTES_SOURCE_MANIFEST: ModuleManifest = {
  id: "notes-source",
  version: "1.0.0",
  deckApi: "^0.1",
  services: { provides: ["sources/reader"] },
};

export const notesSourceModule: ServerModule = {
  manifest: NOTES_SOURCE_MANIFEST,
  init: (ctx) => {
    ctx.services.provide(SOURCE_READER, { get: (id) => (id === notes.id ? notes : undefined) });
  },
};
