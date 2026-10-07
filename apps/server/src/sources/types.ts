/**
 * The sources browsing wire types, for the web's docs and configs pages. Types only:
 * importing this entry point never pulls server code into a bundle. Exactly the wire types
 * the web renders; the server-internal store, reader and runtime types stay unexported.
 */
export type {
  FileReadResult,
  SourceKind,
  SourceManifest,
  SourceSearchMatch,
  SourceSearchResult,
  SourceTreeNode,
} from "./tree.js";
