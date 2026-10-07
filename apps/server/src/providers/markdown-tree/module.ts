import type { JsonSchema } from "@deck/module-sdk";

import { defineSourceKindModule, sourceKindManifest, type SourceKindModuleOptions } from "../../sources/kind-module.js";
import { MARKDOWN_TREE_KIND, MarkdownTreeProvider } from "./index.js";
import instanceSchema from "./instance.schema.json" with { type: "json" };

/**
 * The `markdown-tree` data source: each `sources[]` instance of kind `markdown-tree` becomes
 * a provider with the source's id, serving its tree manifest. The Docs page renders it.
 */
export const MARKDOWN_TREE_MANIFEST = sourceKindManifest(MARKDOWN_TREE_KIND, instanceSchema as JsonSchema);

export function createMarkdownTreeModule(options?: SourceKindModuleOptions) {
  return defineSourceKindModule(
    MARKDOWN_TREE_MANIFEST,
    (id, source, store) => new MarkdownTreeProvider(id, source, store),
    options,
  );
}

export const markdownTreeModule = createMarkdownTreeModule();
