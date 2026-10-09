/**
 * The markdown rendering pipeline (06 §5, REQ-DOCS-03/04/05, REQ-SEC-01/SC-08/SC-17).
 *
 * Composes `markdown-it` + `markdown-it-task-lists` + `highlight.js` + `DOMPurify` into a pure
 * string→string transform: raw markdown → **sanitized** HTML ready to inject into the DOM. The
 * DOMPurify pass is the single enforced XSS boundary — untrusted repository markdown cannot
 * execute script in the hub. The component (`MarkdownView`, 06 §11) injects only this return
 * value; there is no un-sanitized render path.
 *
 * Relative inter-doc links are rewritten to stay inside the Docs view; relative images are
 * rewritten to the confined raw route; external links stay external with
 * `rel="noopener noreferrer"`.
 */

import { isExternalHref, isSafeHref } from "@deck/module-sdk";
import DOMPurify, { type Config as DOMPurifyConfig } from "dompurify";
import MarkdownIt from "markdown-it";
import taskLists from "markdown-it-task-lists";

import { rawAssetUrl } from "./client.js";
import { highlightCode } from "./highlight.js";

/** Context the renderer needs to rewrite relative links/images against the current doc. */
export interface MarkdownRenderContext {
  /** The active source id — the `:id` segment for in-app Docs routes and the raw route. */
  readonly sourceId: string;
  /** POSIX path of the document being rendered, relative to the source root. Relative links
   *  and images inside the doc resolve against this path's directory. */
  readonly docPath: string;
}

/** True for an absolute web/mail URL that must stay external (never rewritten in-app). */
function isExternal(url: string): boolean {
  return /^(?:https?:|mailto:)/i.test(url);
}

/** Directory portion of a POSIX path (everything before the final `/`), or "" at the root. */
function dirnamePosix(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

/** Split a `#fragment` off a link target so the path can be resolved independently. */
function splitHash(target: string): { readonly path: string; readonly hash: string } {
  const hash = target.indexOf("#");
  return hash === -1
    ? { path: target, hash: "" }
    : { path: target.slice(0, hash), hash: target.slice(hash) };
}

/**
 * Resolve a link/image target relative to a document into a POSIX path relative to the source
 * root. Collapses `./` and `../`, strips a leading `/` (root-relative within the source), and
 * never returns a path that escapes the root's own prefix (a `../` past the root normalizes
 * away — the server then confines whatever remains). Pure; exported for standalone tests.
 *
 * @example resolveRelative("guides/setup.md", "../intro.md") === "intro.md"
 * @example resolveRelative("guides/setup.md", "./img/x.png") === "guides/img/x.png"
 */
export function resolveRelative(docPath: string, target: string): string {
  const segments = target.startsWith("/")
    ? [] // root-relative within the source root
    : dirnamePosix(docPath).split("/").filter(Boolean);
  for (const segment of target.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.join("/");
}

/** Fenced-code highlight hook — delegates to the shared highlight.js wrapper (`highlight.ts`)
 *  and returns a complete, hljs-classed `<pre>` block so markdown-it emits it verbatim. */
function highlightFence(code: string, language: string): string {
  const { value, language: applied } = highlightCode(code, language);
  const className = applied ? `hljs language-${applied}` : "hljs";
  return `<pre class="hljs"><code class="${className}">${value}</code></pre>`;
}

const md: MarkdownIt = new MarkdownIt({
  html: true, // raw HTML is parsed so DOMPurify (not markdown-it) is the single sanitizer
  linkify: true,
  typographer: false,
  highlight: highlightFence,
}).use(taskLists, { enabled: false, label: true });

/** Rewrite `link_open` hrefs: external links open in a new tab with a safe `rel`; relative
 *  inter-doc links become in-app `/docs?source=…&path=…` routes (06 §5.3). */
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const context = env as Partial<MarkdownRenderContext>;
  const token = tokens[idx];
  const href = token.attrGet("href") ?? "";
  if (isExternal(href)) {
    token.attrSet("target", "_blank");
    token.attrSet("rel", "noopener noreferrer");
  } else if (!href.startsWith("#") && context.sourceId !== undefined && context.docPath !== undefined) {
    const { path, hash } = splitHash(href);
    const resolved = resolveRelative(context.docPath, path);
    token.attrSet(
      "href",
      `/docs?source=${encodeURIComponent(context.sourceId)}&path=${encodeURIComponent(resolved)}${hash}`,
    );
  }
  return self.renderToken(tokens, idx, options);
};

/** Rewrite relative image `src` to the confined raw route; absolute URLs pass through (06 §5.4). */
md.renderer.rules.image = (tokens, idx, options, env, self) => {
  const context = env as Partial<MarkdownRenderContext>;
  const token = tokens[idx];
  const src = token.attrGet("src") ?? "";
  if (!isExternal(src) && context.sourceId !== undefined && context.docPath !== undefined) {
    token.attrSet("src", rawAssetUrl(context.sourceId, resolveRelative(context.docPath, src)));
  }
  return self.renderToken(tokens, idx, options);
};

/** DOMPurify config — the XSS boundary (06 §5.2). Permit the rewritten link/image attrs;
 *  forbid script/style/embedding tags and event-handler attributes. */
const SANITIZE_CONFIG: DOMPurifyConfig = {
  ADD_ATTR: ["target", "rel"],
  FORBID_TAGS: ["script", "style", "iframe", "object", "embed", "form"],
  FORBID_ATTR: ["onerror", "onload", "onclick", "srcdoc"],
  ALLOW_DATA_ATTR: false,
};

/**
 * Render a markdown document to a **sanitized** HTML string, ready to inject into the DOM. GFM
 * (tables, strikethrough, task lists) + fenced-code syntax highlighting; relative links/images
 * rewritten (§5.3/§5.4); embedded raw HTML/scripts stripped by DOMPurify BEFORE the string is
 * returned (the XSS boundary). Pure and synchronous; safe to call in render.
 *
 * Without a context (a dashboard's markdown widget, which belongs to no source) links and images
 * keep their targets as written; external links still open in a new tab, and DOMPurify still
 * sanitizes everything.
 *
 * @param markdown  the raw document body (`FileReadResult.content`).
 * @param context   the source id + doc path used for relative rewriting, if any.
 * @param options   how the caller embeds it (a heading offset for a dashboard widget).
 * @returns a sanitized HTML string containing no executable script or event-handler attrs.
 */
export function renderMarkdown(
  markdown: string,
  context?: MarkdownRenderContext,
  options: MarkdownRenderOptions = {},
): string {
  const rendered = md.render(markdown, { ...context });
  const html = options.headingOffset === undefined ? rendered : demoteHeadings(rendered, options.headingOffset);
  // The sanitiser runs last: nothing parses, changes or re-serialises its output. The link
  // policy runs inside it, on the very nodes it returns, for this call only (it is synchronous).
  if (options.externalLinksOnly !== true) return DOMPurify.sanitize(html, SANITIZE_CONFIG) as string;
  DOMPurify.addHook("afterSanitizeAttributes", externalLinksOnly);
  try {
    return DOMPurify.sanitize(html, SANITIZE_CONFIG) as string;
  } finally {
    DOMPurify.removeHook("afterSanitizeAttributes", externalLinksOnly);
  }
}

/** Attributes that fetch or submit: under the external-only policy each keeps only an absolute http(s) URL. */
const RESOURCE_ATTRIBUTES = ["src", "action", "formaction", "poster", "background", "cite", "longdesc", "data"] as const;

/** Whether a URL may stay under the external-only policy: an absolute http(s) URL `isSafeHref` accepts. */
function isExternalOnly(url: string | null): url is string {
  return url !== null && isExternalHref(url) && isSafeHref(url);
}

/**
 * The external-only link policy, on one sanitised node of any kind (an `a`, an image map's
 * `area`, an SVG link, an image or a button): every attribute that navigates, submits or fetches
 * keeps only an absolute http(s) URL `isSafeHref` accepts, and `srcset` and `ping` go. A link
 * (`a`, `area`) that keeps its href opens as an external link (new tab, safe `rel`, and for an
 * `a` its marker and a "(opens in new tab)" note); one that loses it reads as plain text. So no
 * markdown from outside deck (a path, a fragment, a protocol-relative `//host`, another scheme)
 * can point into deck.
 */
function externalLinksOnly(node: Element): void {
  const name = node.nodeName.toLowerCase();
  const isLink = name === "a" || name === "area";
  const href = node.getAttribute("href") ?? node.getAttribute("xlink:href");
  for (const attribute of ["href", "xlink:href", "target", "rel", "srcset", "ping", "download"]) node.removeAttribute(attribute);
  for (const attribute of RESOURCE_ATTRIBUTES) {
    if (node.hasAttribute(attribute) && !isExternalOnly(node.getAttribute(attribute))) node.removeAttribute(attribute);
  }
  if (!isExternalOnly(href)) return;
  node.setAttribute("href", href);
  if (!isLink) return;
  node.setAttribute("target", "_blank");
  node.setAttribute("rel", "noopener noreferrer");
  if (name !== "a") return;
  const marker = node.ownerDocument.createElement("span");
  marker.setAttribute("aria-hidden", "true");
  marker.textContent = " ↗";
  const note = node.ownerDocument.createElement("span");
  note.setAttribute("class", "sr-only");
  note.textContent = " (opens in new tab)";
  node.append(marker, note);
}

/** How a caller embeds the rendered document. */
export interface MarkdownRenderOptions {
  /**
   * Levels to move every heading down (at most `h6`), raw HTML headings included: a dashboard
   * widget's markdown sits under its card's `h3`. The docs view leaves headings as written.
   */
  headingOffset?: number;
  /**
   * Keep only absolute http(s) links, each opened as an external link, and make every other
   * link plain text: for markdown from outside deck (a widget a sidecar contributes), whose
   * links, raw HTML or source data must not point into deck.
   */
  externalLinksOnly?: boolean;
}

/**
 * Rendered (not yet sanitised) HTML with every heading `by` levels lower. It parses into an
 * inert template (no script runs, no resource loads), renames the heading elements keeping their
 * attributes and children, and serialises; DOMPurify then sanitises the result.
 */
function demoteHeadings(html: string, by: number): string {
  const template = document.createElement("template");
  template.innerHTML = html;
  for (const heading of template.content.querySelectorAll("h1, h2, h3, h4, h5, h6")) {
    const demoted = document.createElement(`h${Math.min(6, Number(heading.tagName.slice(1)) + by)}`);
    for (const { name, value } of heading.attributes) demoted.setAttribute(name, value);
    demoted.append(...heading.childNodes);
    heading.replaceWith(demoted);
  }
  return template.innerHTML;
}
