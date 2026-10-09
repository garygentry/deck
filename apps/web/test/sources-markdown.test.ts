// @vitest-environment jsdom
//
// DOMPurify requires a DOM `window`; the default server-render (renderToStaticMarkup) path has none, so
// this one file runs under vitest's jsdom environment (06 §5.5, 08 §5.1). It exercises the
// pure markdown.ts string→sanitized-HTML pipeline (the enforced XSS boundary, SC-08) — it is
// not a component render test.

import { describe, expect, it, vi } from "vitest";

import {
  renderMarkdown,
  resolveRelative,
} from "../src/features/sources-docs-and-configs/markdown.js";
import {
  highlightCode,
  highlightFile,
  languageForName,
} from "../src/features/sources-docs-and-configs/highlight.js";

const SOURCE_ID = "docs";
const ctx = (docPath: string): { sourceId: string; docPath: string } => ({
  sourceId: SOURCE_ID,
  docPath,
});

/** Parse rendered HTML and read one element's attribute (entities decoded, %-encoding kept). */
function attr(html: string, selector: string, name: string): string | null {
  const doc = new DOMParser().parseFromString(html, "text/html");
  return doc.querySelector(selector)?.getAttribute(name) ?? null;
}

/** Parse rendered HTML into a document for structural (DOM) assertions. */
function parse(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

describe("highlight.ts — language selection & non-throwing fallback", () => {
  it("selects a highlight.js language by extension and by name", () => {
    expect(languageForName("config/app.yaml")).toBe("yaml");
    expect(languageForName("service.json")).toBe("json");
    expect(languageForName("Dockerfile")).toBe("dockerfile");
    // A bare extension (as a fence info string would supply) resolves too.
    expect(languageForName("yaml")).toBe("yaml");
    expect(languageForName(".yaml")).toBe("yaml");
  });

  it("returns undefined for an unknown extension (⇒ plaintext)", () => {
    expect(languageForName("mystery.zzz")).toBeUndefined();
    expect(languageForName("noextension")).toBeUndefined();
  });

  it("highlights a known language with hljs markup and never throws on unknown", () => {
    const known = highlightCode("const x = 1;", "typescript");
    expect(known.language).toBe("typescript");
    expect(known.value).toContain('<span class="hljs-');

    // An unknown/unregistered language falls back to escaped plaintext without throwing.
    const unknown = highlightCode("<not & code>", "totally-not-a-language");
    expect(unknown.language).toBeNull();
    expect(unknown.value).toBe("&lt;not &amp; code&gt;");

    // No language at all is also a safe, escaped fallback.
    const none = highlightCode("<x>", undefined);
    expect(none.language).toBeNull();
    expect(none.value).toBe("&lt;x&gt;");
  });

  it("highlightFile resolves the language from the file name", () => {
    const result = highlightFile("key: value", "config/app.yaml");
    expect(result.language).toBe("yaml");
  });
});

describe("markdown.ts — resolveRelative", () => {
  it("resolves relative targets to a source-root POSIX path", () => {
    expect(resolveRelative("guides/setup.md", "../intro.md")).toBe("intro.md");
    expect(resolveRelative("guides/setup.md", "./img/x.png")).toBe("guides/img/x.png");
    expect(resolveRelative("index.md", "./sub/guide.md")).toBe("sub/guide.md");
    expect(resolveRelative("a/b/c.md", "/root.md")).toBe("root.md");
  });
});

describe("markdown.ts — GFM rendering (REQ-DOCS-03)", () => {
  it("renders tables, disabled task-list checkboxes, and highlighted fenced code", () => {
    const doc = [
      "| A | B |",
      "| - | - |",
      "| 1 | 2 |",
      "",
      "- [ ] todo",
      "- [x] done",
      "",
      "```ts",
      "const x: number = 1;",
      "```",
    ].join("\n");
    const html = renderMarkdown(doc, ctx("index.md"));

    expect(html).toContain("<table>");
    // Task-list checkboxes render as disabled inputs (read-only, REQ-RO-01).
    const checkboxes = parse(html).querySelectorAll('input[type="checkbox"]');
    expect(checkboxes.length).toBe(2);
    for (const box of checkboxes) expect(box.hasAttribute("disabled")).toBe(true);
    // Fenced code is highlight.js-classed.
    expect(html).toMatch(/<code class="hljs/);
    expect(html).toContain("hljs-");
  });
});

describe("markdown.ts — sanitization (REQ-SEC-01, SC-08) — the XSS boundary", () => {
  it("strips <script>, onerror, and javascript: hrefs from the injected string", () => {
    // Raw HTML vectors (html:true parses them so DOMPurify — the single sanitizer — cleans
    // them uniformly). Assert on the exact string the component will inject.
    const doc = [
      "<script>alert(1)</script>",
      "",
      '<img src=x onerror="alert(1)">',
      "",
      '<a href="javascript:alert(1)">click</a>',
    ].join("\n");
    const html = renderMarkdown(doc, ctx("index.md"));

    expect(html).not.toContain("<script");
    expect(html).not.toContain("onerror");
    expect(html).not.toContain("javascript:");
    // DOM-level: no script element survives and no anchor carries a javascript: href.
    const doc2 = parse(html);
    expect(doc2.querySelector("script")).toBeNull();
    for (const anchor of doc2.querySelectorAll("a")) {
      expect(anchor.getAttribute("href")?.startsWith("javascript:")).not.toBe(true);
    }
  });
});

describe("markdown.ts — link rewriting (REQ-DOCS-04)", () => {
  it("rewrites a relative inter-doc link to an in-app Docs route", () => {
    // Path segments are percent-encoded (spec §5.3 uses encodeURIComponent(path)); the DOM
    // href attribute keeps `%2F` and decodes the `&amp;` entity back to `&`.
    const href = attr(renderMarkdown("[guide](./sub/guide.md)", ctx("index.md")), "a", "href");
    expect(href).toBe(`/docs?source=${SOURCE_ID}&path=sub%2Fguide.md`);
  });

  it("leaves an absolute link external with rel=noopener noreferrer", () => {
    const html = renderMarkdown("[home](https://example.com/page)", ctx("index.md"));
    expect(attr(html, "a", "href")).toBe("https://example.com/page");
    expect(attr(html, "a", "rel")).toBe("noopener noreferrer");
    expect(attr(html, "a", "target")).toBe("_blank");
  });
});

describe("markdown.ts — image rewriting (REQ-DOCS-05, SC-17)", () => {
  it("rewrites a relative image to the confined raw route", () => {
    const src = attr(renderMarkdown("![logo](img/logo.png)", ctx("index.md")), "img", "src");
    expect(src).toBe(`/api/sources/${SOURCE_ID}/raw?path=img%2Flogo.png`);
  });

  it("passes an absolute image URL through unchanged", () => {
    const html = renderMarkdown("![ext](https://cdn.example.com/a.png)", ctx("index.md"));
    expect(attr(html, "img", "src")).toBe("https://cdn.example.com/a.png");
  });
});

describe("markdown.ts — heading offset (dashboard widgets)", () => {
  it("leaves the docs view's headings as written", () => {
    const html = renderMarkdown("# Title\n\n<h2>Raw</h2>", ctx("index.md"));
    expect(new DOMParser().parseFromString(html, "text/html").querySelector("h1")?.textContent).toBe("Title");
    expect(attr(html, "h2", "id")).toBeNull();
  });

  it("moves headings down before sanitising, capped at h6, and still sanitises them", () => {
    const html = renderMarkdown('# One\n\n#### Four\n\n<h2 onclick="x()">Raw</h2>', undefined, { headingOffset: 3 });
    const doc = new DOMParser().parseFromString(html, "text/html");
    expect([...doc.querySelectorAll("h1, h2, h3, h4, h5, h6")].map((node) => node.tagName)).toEqual(["H4", "H6", "H5"]);
    expect(attr(html, "h5", "onclick")).toBeNull();
  });
});

describe("renderMarkdown: external links only, checked as the page parses it", () => {
  it("fails closed to text when the sanitised output still breaks the policy (a parser difference)", async () => {
    const DOMPurify = (await import("dompurify")).default;
    const real = DOMPurify.sanitize.bind(DOMPurify);
    // Stand in for a parser difference: the policy pass keeps returning a link into deck.
    const spy = vi.spyOn(DOMPurify, "sanitize").mockImplementation(((html: string, config?: { ALLOWED_TAGS?: unknown }) =>
      Array.isArray(config?.ALLOWED_TAGS) && config.ALLOWED_TAGS.length === 0 ? real(html, config as never) : '<a href="/api/actions">run</a>') as never);
    try {
      const html = renderMarkdown("[run](https://ok.example/)", undefined, { externalLinksOnly: true });
      expect(html).toBe("run");
      // Policy pass, two re-checks, then the text-only pass.
      expect(spy).toHaveBeenCalledTimes(4);
    } finally {
      spy.mockRestore();
    }
  });

  it("returns the policy pass's output when the page's parse agrees", () => {
    const html = renderMarkdown("[ok](https://ok.example/) and [no](/api/x)", undefined, { externalLinksOnly: true });
    expect(html).toContain('href="https://ok.example/"');
    expect(html).not.toContain("/api/x");
  });
});
