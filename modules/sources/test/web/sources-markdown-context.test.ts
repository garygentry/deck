// @vitest-environment jsdom
//
// The Docs view's rewrites, through the kernel markdown pipeline (DOMPurify needs a DOM).

import { describe, expect, it } from "vitest";

// ui-deep-import: the markdown pipeline is not in the barrel, so it stays out of the main bundle.
import { renderMarkdown } from "@/ui/lib/markdown.js";

import { docsMarkdownContext } from "../../web/markdown-context.js";

const SOURCE_ID = "docs";

/** Parse rendered HTML and read one element's attribute (entities decoded, %-encoding kept). */
function attr(html: string, selector: string, name: string): string | null {
  return new DOMParser().parseFromString(html, "text/html").querySelector(selector)?.getAttribute(name) ?? null;
}

describe("docsMarkdownContext", () => {
  it("rewrites a relative inter-doc link to an in-app Docs route", () => {
    // The path is percent-encoded; the DOM href attribute keeps `%2F` and decodes `&amp;` to `&`.
    const href = attr(renderMarkdown("[guide](./sub/guide.md)", docsMarkdownContext(SOURCE_ID, "index.md")), "a", "href");
    expect(href).toBe(`/docs?source=${SOURCE_ID}&path=sub%2Fguide.md`);
    const hashed = attr(renderMarkdown("[up](../intro.md#start)", docsMarkdownContext(SOURCE_ID, "guides/setup.md")), "a", "href");
    expect(hashed).toBe(`/docs?source=${SOURCE_ID}&path=intro.md#start`);
  });

  it("rewrites a relative image to the confined raw route", () => {
    const src = attr(renderMarkdown("![logo](img/logo.png)", docsMarkdownContext(SOURCE_ID, "index.md")), "img", "src");
    expect(src).toBe(`/api/sources/${SOURCE_ID}/raw?path=img%2Flogo.png`);
  });

  it("leaves absolute links and images as written", () => {
    const html = renderMarkdown("[home](https://example.com/page) ![ext](https://cdn.example.com/a.png)", docsMarkdownContext(SOURCE_ID, "index.md"));
    expect(attr(html, "a", "href")).toBe("https://example.com/page");
    expect(attr(html, "img", "src")).toBe("https://cdn.example.com/a.png");
  });
});
