/**
 * Icons modules contribute as SVG markup (`contributes.icons`, served in the UI manifest's
 * `icons`), for `Icon` names outside the curated set. Each is checked once, when the manifest
 * delivers it, and rebuilt from an allowlist; one that is refused renders the fallback icon
 * like any unknown name.
 */
import { MAX_ICON_BYTES } from "@deck/module-sdk";

const SVG_NS = "http://www.w3.org/2000/svg";

/** The elements an icon may hold: shapes, grouping, paint servers, clipping and text alternatives. */
const ELEMENTS: ReadonlySet<string> = new Set([
  "svg", "g", "path", "circle", "ellipse", "line", "polyline", "polygon", "rect", "defs",
  "linearGradient", "radialGradient", "stop", "clipPath", "mask", "symbol", "use", "title", "desc",
]);

/** The attributes kept: geometry and paint. Any other attribute is dropped (or, if it is one below, refused). */
const ATTRIBUTES: ReadonlySet<string> = new Set([
  "id", "viewBox", "preserveAspectRatio", "width", "height", "x", "y", "x1", "y1", "x2", "y2",
  "cx", "cy", "r", "rx", "ry", "fx", "fy", "fr", "d", "points", "pathLength", "transform",
  "fill", "fill-opacity", "fill-rule", "stroke", "stroke-width", "stroke-linecap",
  "stroke-linejoin", "stroke-miterlimit", "stroke-dasharray", "stroke-dashoffset",
  "stroke-opacity", "opacity", "clip-path", "clip-rule", "mask", "color", "vector-effect",
  "offset", "stop-color", "stop-opacity", "gradientUnits", "gradientTransform", "spreadMethod",
  "clipPathUnits", "maskUnits", "maskContentUnits",
]);

/** Presentation attributes whose value may be a URL: only a local `url(#id)`. */
const URL_ATTRIBUTES: ReadonlySet<string> = new Set(["fill", "stroke", "clip-path", "mask", "filter", "marker-start", "marker-mid", "marker-end"]);

const LOCAL_ID = /^#[A-Za-z_][\w.-]*$/;
const LOCAL_URL = /^url\(#[A-Za-z_][\w.-]*\)$/;

/** Thrown inside the rebuild when the markup holds something an icon may never have. */
class Refused extends Error {}

/**
 * An icon's markup rebuilt from the allowlist as a detached `<svg>`, or null when it is refused.
 * Refused outright:
 * - markup over the size bound, not well-formed XML, with a doctype, or not rooted in an SVG `<svg>`;
 * - any element outside the allowlist, such as `<style>`, `<script>`, `<a>`, `<image>`,
 *   `<feImage>` or `<foreignObject>`;
 * - a `style` or event-handler attribute;
 * - an `href` or `xlink:href`, on any element, to anything but a local `#id`;
 * - a `url(` anywhere but a URL-valued presentation attribute holding exactly `url(#id)`;
 * - a backslash in any attribute (a CSS escape).
 * Other attributes outside the allowlist, comments and text outside `<title>`/`<desc>` are dropped.
 */
export function sanitizeIconSvg(markup: string): SVGSVGElement | null {
  if (typeof markup !== "string" || new TextEncoder().encode(markup).length > MAX_ICON_BYTES) return null;
  const parsed = new DOMParser().parseFromString(markup, "image/svg+xml");
  const root = parsed.documentElement;
  if (parsed.doctype !== null || parsed.getElementsByTagName("parsererror").length > 0 || root.localName !== "svg") return null;
  try {
    return rebuild(root) as SVGSVGElement;
  } catch (error) {
    if (error instanceof Refused) return null;
    throw error;
  }
}

function rebuild(source: Element): Element {
  if (source.namespaceURI !== SVG_NS || !ELEMENTS.has(source.localName)) throw new Refused();
  const element = document.createElementNS(SVG_NS, source.localName);
  for (const attribute of Array.from(source.attributes)) {
    const { localName: name, value } = attribute;
    if (attribute.prefix === "xmlns" || name === "xmlns") continue;
    if (name === "style" || /^on/i.test(name) || value.includes("\\")) throw new Refused();
    if (name === "href") {
      if (!LOCAL_ID.test(value.trim())) throw new Refused();
      element.setAttribute("href", value.trim());
      continue;
    }
    if (/url\s*\(/i.test(value) && !(URL_ATTRIBUTES.has(name) && LOCAL_URL.test(value.trim()))) throw new Refused();
    if (attribute.namespaceURI === null && ATTRIBUTES.has(name)) element.setAttribute(name, value);
  }
  for (const child of Array.from(source.childNodes)) {
    if (child.nodeType === Node.ELEMENT_NODE) element.append(rebuild(child as Element));
    else if (child.nodeType === Node.TEXT_NODE && (source.localName === "title" || source.localName === "desc")) element.append(child.textContent ?? "");
  }
  return element;
}

/**
 * A copy of a sanitised icon whose ids are unique to one rendering: every `id` gets `prefix`,
 * and so does every reference to one (`href="#id"`, `url(#id)`), so two copies on a page
 * never share an id or point into each other.
 */
export function scopeIconIds(svg: SVGSVGElement, prefix: string): SVGSVGElement {
  const copy = svg.cloneNode(true) as SVGSVGElement;
  for (const element of [copy, ...Array.from(copy.querySelectorAll("*"))]) {
    for (const attribute of Array.from(element.attributes)) {
      if (attribute.name === "id") attribute.value = `${prefix}${attribute.value}`;
      else if (attribute.name === "href") attribute.value = `#${prefix}${attribute.value.slice(1)}`;
      else if (LOCAL_URL.test(attribute.value)) attribute.value = `url(#${prefix}${attribute.value.slice(5)}`;
    }
  }
  return copy;
}

let icons: ReadonlyMap<string, SVGSVGElement> = new Map();
let version = 0;
const listeners = new Set<() => void>();

/** Replace the contributed icons with the manifest's (unchecked input: a malformed value is ignored). */
export function setContributedIcons(value: unknown): void {
  const next = new Map<string, SVGSVGElement>();
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    for (const [name, markup] of Object.entries(value as Record<string, unknown>)) {
      const svg = typeof markup === "string" ? sanitizeIconSvg(markup) : null;
      if (svg !== null) next.set(name, svg);
      else if (import.meta.env.DEV) console.warn(`[deck] contributed icon "${name}" was refused; rendering the fallback icon.`);
    }
  }
  if (next.size === 0 && icons.size === 0) return;
  icons = next;
  version += 1;
  for (const listener of listeners) listener();
}

/** A contributed icon's sanitised `<svg>` (shared: copy it before changing it), or undefined. */
export function getContributedIcon(name: string): SVGSVGElement | undefined {
  return icons.get(name);
}

export function subscribeContributedIcons(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getContributedIconsVersion(): number {
  return version;
}

/** Whether a name has the form of a module's icon, `<module>/<name>`. */
export function isContributedIconName(name: string): boolean {
  return /^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/.test(name);
}
