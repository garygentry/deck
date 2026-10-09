/**
 * Icons modules contribute as SVG markup (`contributes.icons`, served in the UI manifest's
 * `icons`), for `Icon` names outside the curated set. Each is checked and sanitised once, when
 * the manifest delivers it; one that is refused renders the fallback icon like any unknown name.
 */
import { MAX_ICON_BYTES } from "@deck/module-sdk";
import DOMPurify from "dompurify";

const SVG_NS = "http://www.w3.org/2000/svg";

let icons: ReadonlyMap<string, SVGSVGElement> = new Map();
let version = 0;
const listeners = new Set<() => void>();

/**
 * An icon's markup as a detached `<svg>` element, or null when it is refused:
 * - it is over the size bound, not well-formed XML, or not rooted in an `<svg>`;
 * - it holds a `<foreignObject>` (HTML inside the SVG);
 * - a `<use>` points anywhere but a local `#id` (another document, a `data:` URL);
 * - a `style` attribute or `<style>` element holds `url(`, which can fetch.
 * What remains is sanitised with DOMPurify's SVG profile: scripts, event handlers and
 * unknown elements are dropped.
 */
export function sanitizeIconSvg(markup: string): SVGSVGElement | null {
  if (typeof markup !== "string" || new TextEncoder().encode(markup).length > MAX_ICON_BYTES) return null;
  const parsed = new DOMParser().parseFromString(markup, "image/svg+xml");
  const root = parsed.documentElement;
  if (parsed.getElementsByTagName("parsererror").length > 0 || root.localName !== "svg" || root.namespaceURI !== SVG_NS) return null;
  if (refused(root)) return null;
  const clean = DOMPurify.sanitize(markup, { USE_PROFILES: { svg: true, svgFilters: true }, RETURN_DOM: true }) as Element;
  const svg = clean.localName === "svg" ? clean : clean.querySelector("svg");
  // Checked again after sanitising, so the two parsers (XML above, HTML in DOMPurify) cannot disagree unseen.
  if (svg === null || svg.namespaceURI !== SVG_NS || refused(svg)) return null;
  return svg as SVGSVGElement;
}

/** Whether an icon's tree holds anything {@link sanitizeIconSvg} refuses outright. */
function refused(root: Element): boolean {
  for (const element of [root, ...Array.from(root.querySelectorAll("*"))]) {
    const name = element.localName.toLowerCase();
    if (name === "foreignobject") return true;
    // `href` and `xlink:href` alike (any attribute named href, in any namespace).
    if (name === "use" && Array.from(element.attributes).some((attribute) => attribute.localName === "href" && !/^#[A-Za-z_][\w.-]*$/.test(attribute.value.trim()))) {
      return true;
    }
    if (/url\s*\(/i.test(element.getAttribute("style") ?? "")) return true;
    if (name === "style" && /url\s*\(/i.test(element.textContent ?? "")) return true;
  }
  return false;
}

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
  icons = next;
  version += 1;
  for (const listener of listeners) listener();
}

/** A contributed icon's sanitised `<svg>` (shared: clone it before changing it), or undefined. */
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
