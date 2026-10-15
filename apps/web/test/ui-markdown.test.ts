// @vitest-environment jsdom
//
// DOMPurify requires a DOM `window`; the default server-render (renderToStaticMarkup) path has none, so
// this one file runs under vitest's jsdom environment. It exercises the pure markdown.ts
// string→sanitized-HTML pipeline (the enforced XSS boundary) — it is not a component render test.

import { describe, expect, it, vi } from "vitest";

import {
  highlightCode,
  highlightFile,
  languageForName,
} from "@/ui/lib/highlight.js";
import {
  renderMarkdown,
  resolveRelative,
  type MarkdownRenderContext,
} from "@/ui/lib/markdown.js";

/** A document context whose rewrites show the resolved path (and hash) they were given. */
const ctx = (docPath: string): MarkdownRenderContext => ({
  docPath,
  linkHref: (path, hash) => `/read/${path}${hash}`,
  imageSrc: (path) => `/asset/${path}`,
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

describe("markdown.ts — GFM rendering", () => {
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
    // Task-list checkboxes render as disabled inputs (read-only).
    const checkboxes = parse(html).querySelectorAll('input[type="checkbox"]');
    expect(checkboxes.length).toBe(2);
    for (const box of checkboxes) expect(box.hasAttribute("disabled")).toBe(true);
    // Fenced code is highlight.js-classed.
    expect(html).toMatch(/<code class="hljs/);
    expect(html).toContain("hljs-");
  });
});

describe("markdown.ts — sanitization — the XSS boundary", () => {
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

describe("markdown.ts — link rewriting", () => {
  it("rewrites a relative link through the context, resolved against the document", () => {
    expect(attr(renderMarkdown("[guide](./sub/guide.md)", ctx("index.md")), "a", "href")).toBe("/read/sub/guide.md");
    expect(attr(renderMarkdown("[up](../intro.md#start)", ctx("guides/setup.md")), "a", "href")).toBe("/read/intro.md#start");
  });

  it("leaves a fragment-only link, and every link without a context, as written", () => {
    expect(attr(renderMarkdown("[top](#top)", ctx("index.md")), "a", "href")).toBe("#top");
    expect(attr(renderMarkdown("[guide](./sub/guide.md)"), "a", "href")).toBe("./sub/guide.md");
  });

  it("leaves an absolute link external with rel=noopener noreferrer", () => {
    const html = renderMarkdown("[home](https://example.com/page)", ctx("index.md"));
    expect(attr(html, "a", "href")).toBe("https://example.com/page");
    expect(attr(html, "a", "rel")).toBe("noopener noreferrer");
    expect(attr(html, "a", "target")).toBe("_blank");
  });
});

describe("markdown.ts — image rewriting", () => {
  it("rewrites a relative image through the context, resolved against the document", () => {
    expect(attr(renderMarkdown("![logo](img/logo.png)", ctx("guides/index.md")), "img", "src")).toBe("/asset/guides/img/logo.png");
    expect(attr(renderMarkdown("![logo](img/logo.png)"), "img", "src")).toBe("img/logo.png");
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

describe("renderMarkdown: external links only loads no resource", () => {
  const external = (markdown: string): string => renderMarkdown(markdown, undefined, { externalLinksOnly: true });

  it("shows a markdown image as its alt text, loading nothing (an image link keeps its name)", () => {
    const html = external('![build status](https://res.example/badge.png) and [![docs badge](https://res.example/d.svg)](https://ok.example/) and <img src="https://res.example/r.png" alt="raw <alt>">');
    const doc = parse(html);
    expect(doc.querySelector("img")).toBeNull();
    expect(doc.body.textContent).toContain("build status");
    expect(doc.body.textContent).toContain("raw <alt>");
    expect(doc.querySelector('a[href="https://ok.example/"]')?.textContent).toContain("docs badge");
    expect(html).not.toContain("res.example");
  });

  it("leaves nothing for an image with no alt text", () => {
    const html = external('before<img src="https://res.example/pixel.gif">after');
    expect(parse(html).body.textContent?.trim()).toBe("beforeafter");
  });

  // Every way markdown's raw HTML could make the page fetch on render; each names res.example.
  const vectors: ReadonlyArray<readonly [string, string]> = [
    ["img src/srcset/lowsrc", '<img src="https://res.example/a.png" srcset="https://res.example/b.png 2x" lowsrc="https://res.example/c.png" alt="a">'],
    ["picture/source", '<picture><source srcset="https://res.example/a.webp" type="image/webp"><img src="https://res.example/a.png" alt="p"></picture>'],
    ["video src/poster/source/track", '<video src="https://res.example/v.mp4" poster="https://res.example/p.png"><source src="https://res.example/v.webm"><track src="https://res.example/t.vtt">fallback</video>'],
    ["audio src/source", '<audio src="https://res.example/a.mp3"><source src="https://res.example/a.ogg"></audio>'],
    ["input type=image", '<input type="image" src="https://res.example/i.png" alt="go">'],
    ["background attributes", '<table background="https://res.example/t.png"><tr><td background="https://res.example/td.png">x</td></tr></table>'],
    ["style attribute url()", '<p style="background-image:url(https://res.example/s.png)">s</p>'],
    ["style element", "<style>@import url(https://res.example/s.css); p{background:url(https://res.example/s.png)}</style>"],
    ["link/meta/base", '<link rel="stylesheet" href="https://res.example/l.css"><link rel="preload" as="image" href="https://res.example/l.png"><meta http-equiv="refresh" content="0;url=https://res.example/"><base href="https://res.example/">'],
    ["svg image href/xlink:href", '<svg><image href="https://res.example/a.svg"></image><image xlink:href="https://res.example/b.svg"></image></svg>'],
    ["svg feImage/use/pattern/textPath", '<svg><filter><feImage href="https://res.example/f.png"></feImage></filter><use href="https://res.example/u.svg#i"></use><pattern href="https://res.example/p.svg#p"></pattern><text><textPath href="https://res.example/t.svg#p">t</textPath></text></svg>'],
    ["svg style and url() reference", '<svg><style>@import url(https://res.example/s.css);</style><rect fill="url(https://res.example/g.svg#g)"></rect></svg>'],
    ["embedding elements", '<iframe src="https://res.example/f.html"></iframe><object data="https://res.example/o.swf"></object><embed src="https://res.example/e.swf">'],
  ];

  it.each(vectors)("drops %s", (_name, raw) => {
    const html = external(raw);
    expect(html).not.toContain("res.example");
    const doc = parse(html);
    expect(doc.querySelector("img, picture source, video, audio, track, image, link, meta, base, style, iframe, object, embed, [src], [srcset], [poster], [background], [style]")).toBeNull();
  });

  it("keeps an image input's alt, with nothing to load", () => {
    const doc = parse(external(vectors[4][1]));
    expect(doc.querySelector('input[type="image"]')?.getAttribute("alt")).toBe("go");
  });

  it("re-checks the page's parse for an attribute that fetches", async () => {
    const DOMPurify = (await import("dompurify")).default;
    const real = DOMPurify.sanitize.bind(DOMPurify);
    // Stand in for a parser difference: the policy pass keeps returning an element that fetches.
    const spy = vi.spyOn(DOMPurify, "sanitize").mockImplementation(((html: string, config?: { ALLOWED_TAGS?: unknown }) =>
      Array.isArray(config?.ALLOWED_TAGS) && config.ALLOWED_TAGS.length === 0 ? real(html, config as never) : '<input type="image" src="https://res.example/i.png" alt="go">') as never);
    try {
      expect(external("x")).toBe("");
    } finally {
      spy.mockRestore();
    }
  });

  it("leaves operator markdown's images and media exactly as before", () => {
    const html = renderMarkdown(
      '![ext](https://cdn.example.com/a.png)\n\n<img src="https://cdn.example.com/b.png" srcset="https://cdn.example.com/b2.png 2x" alt="b">\n\n<video src="https://cdn.example.com/v.mp4" poster="https://cdn.example.com/p.png"></video>',
      ctx("index.md"),
    );
    expect(attr(html, "p > img", "src")).toBe("https://cdn.example.com/a.png");
    expect(attr(html, 'img[alt="b"]', "srcset")).toBe("https://cdn.example.com/b2.png 2x");
    expect(attr(html, "video", "poster")).toBe("https://cdn.example.com/p.png");
    expect(attr(renderMarkdown("![logo](img/logo.png)", ctx("guides/index.md")), "img", "src")).toBe("/asset/guides/img/logo.png");
  });
});
