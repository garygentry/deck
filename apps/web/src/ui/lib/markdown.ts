/**
 * deck's markdown rendering pipeline, shared by every surface that shows markdown (the docs
 * view, the markdown widget).
 *
 * Composes `markdown-it` + `markdown-it-task-lists` + `highlight.js` + `DOMPurify` into a pure
 * string→string transform: raw markdown → **sanitized** HTML ready to inject into the DOM. The
 * DOMPurify pass is the single enforced XSS boundary — untrusted markdown cannot execute script
 * in the hub. A caller injects only this return value (through `Prose`); there is no
 * un-sanitized render path.
 *
 * Given a document context, relative links and images are rewritten through it (the caller
 * decides where they point); external links stay external with `rel="noopener noreferrer"`.
 */

import { isExternalHref, isSafeHref } from "@deck/module-sdk";
import DOMPurify, { type Config as DOMPurifyConfig } from "dompurify";
import MarkdownIt from "markdown-it";
import taskLists from "markdown-it-task-lists";

import { highlightCode } from "./highlight.js";

/** Context the renderer needs to rewrite relative links/images against the current doc. */
export interface MarkdownRenderContext {
  /** POSIX path of the document being rendered, relative to its tree's root. Relative links
   *  and images inside the doc resolve against this path's directory. */
  readonly docPath: string;
  /** The href of a relative link: its target resolved against `docPath`, and its `#fragment`
   *  (empty when it has none). */
  linkHref(resolvedPath: string, hash: string): string;
  /** The `src` of a relative image: its target resolved against `docPath`. */
  imageSrc(resolvedPath: string): string;
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
 * Resolve a link/image target relative to a document into a POSIX path relative to the root of
 * the document's tree. Collapses `./` and `../`, strips a leading `/` (root-relative within the
 * tree), and never returns a path that escapes the root's own prefix (a `../` past the root
 * normalizes away; whatever serves the path still confines it). Pure; exported for tests.
 *
 * @example resolveRelative("guides/setup.md", "../intro.md") === "intro.md"
 * @example resolveRelative("guides/setup.md", "./img/x.png") === "guides/img/x.png"
 */
export function resolveRelative(docPath: string, target: string): string {
  const segments = target.startsWith("/")
    ? [] // root-relative within the tree
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

/** markdown-it's per-render `env`: the caller's document context, if any. */
interface RenderEnv {
  readonly context?: MarkdownRenderContext;
}

/** Rewrite `link_open` hrefs: external links open in a new tab with a safe `rel`; relative
 *  links go through the context's `linkHref`. */
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const { context } = env as RenderEnv;
  const token = tokens[idx];
  const href = token.attrGet("href") ?? "";
  if (isExternal(href)) {
    token.attrSet("target", "_blank");
    token.attrSet("rel", "noopener noreferrer");
  } else if (!href.startsWith("#") && context !== undefined) {
    const { path, hash } = splitHash(href);
    token.attrSet("href", context.linkHref(resolveRelative(context.docPath, path), hash));
  }
  return self.renderToken(tokens, idx, options);
};

/** Rewrite a relative image `src` through the context's `imageSrc`; absolute URLs pass through. */
md.renderer.rules.image = (tokens, idx, options, env, self) => {
  const { context } = env as RenderEnv;
  const token = tokens[idx];
  const src = token.attrGet("src") ?? "";
  if (!isExternal(src) && context !== undefined) {
    token.attrSet("src", context.imageSrc(resolveRelative(context.docPath, src)));
  }
  return self.renderToken(tokens, idx, options);
};

/** DOMPurify config — the XSS boundary. Permit the rewritten link/image attrs; forbid
 *  script/style/embedding tags and event-handler attributes. */
const SANITIZE_CONFIG: DOMPurifyConfig = {
  ADD_ATTR: ["target", "rel"],
  FORBID_TAGS: ["script", "style", "iframe", "object", "embed", "form"],
  FORBID_ATTR: ["onerror", "onload", "onclick", "srcdoc"],
  ALLOW_DATA_ATTR: false,
};

/**
 * Render a markdown document to a **sanitized** HTML string, ready to inject into the DOM. GFM
 * (tables, strikethrough, task lists) + fenced-code syntax highlighting; relative links/images
 * rewritten through `context`; embedded raw HTML/scripts stripped by DOMPurify BEFORE the string
 * is returned (the XSS boundary). Pure and synchronous; safe to call in render.
 *
 * Without a context (a dashboard's markdown widget, which belongs to no tree) links and images
 * keep their targets as written; external links still open in a new tab, and DOMPurify still
 * sanitizes everything.
 *
 * @param markdown  the raw document body.
 * @param context   the document path and the rewrites for its relative links and images, if any.
 * @param options   how the caller embeds it (a heading offset for a dashboard widget).
 * @returns a sanitized HTML string containing no executable script or event-handler attrs.
 */
export function renderMarkdown(
  markdown: string,
  context?: MarkdownRenderContext,
  options: MarkdownRenderOptions = {},
): string {
  const env: RenderEnv = context === undefined ? {} : { context };
  const rendered = md.render(markdown, env);
  const html = options.headingOffset === undefined ? rendered : demoteHeadings(rendered, options.headingOffset);
  // The sanitiser runs last: nothing parses, changes or re-serialises its output. The link
  // policy runs inside it, on the very nodes it returns, for this call only (it is synchronous).
  if (options.externalLinksOnly !== true) return DOMPurify.sanitize(html, SANITIZE_CONFIG) as string;
  // The policy checks the DOM the sanitiser built, but the page parses the string it returns.
  // So the output is checked again as the page will parse it: if a parser difference left a
  // link or URL behind, it is sanitised again, and if that does not settle it, only its text
  // is kept (fail closed).
  let safe = sanitizeExternalLinksOnly(html);
  for (let pass = 0; pass < 2 && breaksExternalLinksOnly(safe); pass += 1) safe = sanitizeExternalLinksOnly(safe);
  return breaksExternalLinksOnly(safe) ? (DOMPurify.sanitize(safe, { ALLOWED_TAGS: [], KEEP_CONTENT: true }) as string) : safe;
}

function sanitizeExternalLinksOnly(html: string): string {
  DOMPurify.addHook("afterSanitizeAttributes", externalLinksOnly);
  try {
    return DOMPurify.sanitize(html, EXTERNAL_LINKS_ONLY_CONFIG) as string;
  } finally {
    DOMPurify.removeHook("afterSanitizeAttributes", externalLinksOnly);
  }
}

/**
 * Whether sanitised HTML, parsed as the page parses it (into an element, as `innerHTML` does),
 * holds anything the external-only policy removes: a forbidden element, an inline style, a
 * `url()`, or a link or resource attribute that is not an absolute http(s) URL.
 */
function breaksExternalLinksOnly(html: string): boolean {
  // A div's innerHTML, as the page sets it, in a document with no browsing context: it runs no
  // script and loads nothing.
  const host = document.implementation.createHTMLDocument("").createElement("div");
  host.innerHTML = html;
  for (const element of host.querySelectorAll("*")) {
    if (EXTERNAL_ONLY_FORBIDDEN_TAGS.has(element.nodeName.toLowerCase())) return true;
    for (const { name, value } of element.attributes) {
      if (name === "style" || name === "srcset" || name === "ping" || /url\s*\(/i.test(value)) return true;
      if ((name === "href" || name === "xlink:href" || (RESOURCE_ATTRIBUTES as readonly string[]).includes(name)) && !isExternalOnly(value)) return true;
    }
  }
  return false;
}

/**
 * The sanitiser config under the external-only policy: also no inline `style` (CSS `url()`
 * fetches), and none of the SVG elements that set a link or fetch by reference rather than
 * through an attribute the policy checks (animations that rewrite `href`, `use`, `feImage`).
 */
const EXTERNAL_ONLY_FORBIDDEN_TAGS: ReadonlySet<string> = new Set([
  ...(SANITIZE_CONFIG.FORBID_TAGS ?? []),
  "animate",
  "animatemotion",
  "animatetransform",
  "set",
  "use",
  "feimage",
]);

const EXTERNAL_LINKS_ONLY_CONFIG: DOMPurifyConfig = {
  ...SANITIZE_CONFIG,
  FORBID_TAGS: [...EXTERNAL_ONLY_FORBIDDEN_TAGS],
  FORBID_ATTR: [...(SANITIZE_CONFIG.FORBID_ATTR ?? []), "style"],
};

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
  // Any other attribute that names a resource by CSS reference (`fill="url(…)"`, `filter`, `mask`) goes too.
  for (const { name: attribute, value } of [...node.attributes]) if (/url\s*\(/i.test(value)) node.removeAttribute(attribute);
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
   * widget's markdown sits under its card's `h3`. Without it, headings stay as written.
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
