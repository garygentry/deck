import type { JsonSchema } from "@deck/module-sdk";

import { defineSourceKindModule, sourceKindManifest, type SourceKindModuleOptions } from "../../sources/kind-module.js";
import { FILE_TREE_KIND, FileTreeProvider } from "./index.js";
import instanceSchema from "./instance.schema.json" with { type: "json" };

/**
 * The `file-tree` data source: each `sources[]` instance of kind `file-tree` becomes a
 * provider with the source's id, serving its tree manifest. The Configs page renders it.
 */
export const FILE_TREE_MANIFEST = sourceKindManifest(FILE_TREE_KIND, instanceSchema as JsonSchema);

export function createFileTreeModule(options?: SourceKindModuleOptions) {
  return defineSourceKindModule(
    FILE_TREE_MANIFEST,
    (id, source, store) => new FileTreeProvider(id, source, store),
    options,
  );
}

export const fileTreeModule = createFileTreeModule();
