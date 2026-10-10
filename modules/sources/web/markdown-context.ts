/**
 * How the Docs view renders a source's markdown through the kernel pipeline: a relative link
 * stays inside the Docs view (`/docs?source=…&path=…`), and a relative image loads from the
 * source's confined raw route.
 */

// ui-deep-import: the markdown pipeline is not in the barrel, so it stays out of the main bundle.
import type { MarkdownRenderContext } from "@/ui/lib/markdown.js";

import { rawAssetUrl } from "./client.js";

/** The render context for one document of a source: `docPath` is its path in the source. */
export function docsMarkdownContext(sourceId: string, docPath: string): MarkdownRenderContext {
  return {
    docPath,
    linkHref: (path, hash) => `/docs?source=${encodeURIComponent(sourceId)}&path=${encodeURIComponent(path)}${hash}`,
    imageSrc: (path) => rawAssetUrl(sourceId, path),
  };
}
