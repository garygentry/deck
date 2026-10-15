/**
 * Inline styles in markup, found before it is parsed. The shell's Content-Security-Policy
 * refuses `style` attributes and un-nonced `<style>` elements, and the browser reports one as
 * soon as markup carrying it is parsed, even into an inert document (as a sanitiser does). So
 * untrusted markup is checked or rewritten as a string first, with a tokeniser that reads tags
 * the way a parser does: an attribute's value, quoted (`"…"`, `'…'`) or not, is never mistaken
 * for a name, text outside tags is never touched, and comments, CDATA sections, `<!…>`/`<?…>`
 * declarations and the contents of raw-text elements (`<script>`, `<textarea>`, `<title>`, …)
 * are skipped whole.
 */

/** Elements whose contents a parser reads as text up to their own end tag, never as markup. */
const RAW_TEXT = new Set(["script", "textarea", "title", "xmp", "noscript", "iframe", "noembed", "noframes", "plaintext"]);

interface Found {
  /** A `style` attribute's name: [start, end) of the name only. */
  readonly attributes: (readonly [number, number])[];
  /** A `<style>` element, its start tag to the end of its end tag (or of the markup): [start, end). */
  readonly elements: (readonly [number, number])[];
}

const isSpace = (char: string | undefined) => char === " " || char === "\t" || char === "\n" || char === "\r" || char === "\f";

/** The local name of a tag name (`svg:style` → `style`), lowercased. */
const localName = (name: string) => name.slice(name.lastIndexOf(":") + 1).toLowerCase();

/** Where the element `name` opened before `from` ends: just past its end tag, or the end of `markup`. */
function endOfElement(markup: string, name: string, from: number): number {
  const close = new RegExp(`</${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=[\\s/>])`, "gi");
  close.lastIndex = from;
  const match = close.exec(markup);
  if (match === null) return markup.length;
  const end = markup.indexOf(">", match.index);
  return end === -1 ? markup.length : end + 1;
}

/**
 * Read one tag starting at `start` (`markup[start]` is `<`, then a letter, or `/` and a letter):
 * its name, and each attribute name's range. Returns where the tag ends (past `>`).
 */
function readTag(markup: string, start: number, onAttribute: (name: string, from: number, to: number) => void): { name: string; end: number; selfClosing: boolean } {
  let at = start + 1;
  if (markup[at] === "/") at += 1;
  const nameStart = at;
  while (at < markup.length && !isSpace(markup[at]) && markup[at] !== "/" && markup[at] !== ">") at += 1;
  const name = markup.slice(nameStart, at);
  let selfClosing = false;
  for (;;) {
    while (at < markup.length && (isSpace(markup[at]) || markup[at] === "/")) {
      selfClosing = markup[at] === "/";
      at += 1;
    }
    if (at >= markup.length) return { name, end: markup.length, selfClosing: false };
    if (markup[at] === ">") return { name, end: at + 1, selfClosing };
    selfClosing = false;
    // An attribute name: up to a space, `/`, `>` or `=` (a leading `=` belongs to the name).
    const attributeStart = at;
    at += 1;
    while (at < markup.length && !isSpace(markup[at]) && markup[at] !== "/" && markup[at] !== ">" && markup[at] !== "=") at += 1;
    onAttribute(markup.slice(attributeStart, at), attributeStart, at);
    let afterName = at;
    while (afterName < markup.length && isSpace(markup[afterName])) afterName += 1;
    if (markup[afterName] !== "=") continue;
    at = afterName + 1;
    while (at < markup.length && isSpace(markup[at])) at += 1;
    const quote = markup[at];
    if (quote === '"' || quote === "'") {
      const close = markup.indexOf(quote, at + 1);
      at = close === -1 ? markup.length : close + 1;
    } else {
      while (at < markup.length && !isSpace(markup[at]) && markup[at] !== ">") at += 1;
    }
  }
}

/**
 * Every inline style in `markup`: `style` attribute names and `<style>` elements. As HTML, a
 * start tag's `/>` closes nothing, and raw-text elements' contents are skipped; as XML, `/>`
 * closes the element and every element's contents are markup.
 */
function findInlineStyles(markup: string, xml: boolean): Found {
  const found: Found = { attributes: [], elements: [] };
  let at = 0;
  while (at < markup.length) {
    const open = markup.indexOf("<", at);
    if (open === -1) break;
    const next = markup[open + 1] ?? "";
    if (markup.startsWith("<!--", open)) {
      const end = markup.indexOf("-->", open + 4);
      at = end === -1 ? markup.length : end + 3;
    } else if (markup.startsWith("<![CDATA[", open)) {
      const end = markup.indexOf("]]>", open + 9);
      at = end === -1 ? markup.length : end + 3;
    } else if (next === "!" || next === "?") {
      const end = markup.indexOf(">", open + 2);
      at = end === -1 ? markup.length : end + 1;
    } else if (/[A-Za-z]/.test(next) || (next === "/" && /[A-Za-z]/.test(markup[open + 2] ?? ""))) {
      const closing = next === "/";
      const tag = readTag(markup, open, (name, from, to) => {
        if (!closing && name.toLowerCase() === "style") found.attributes.push([from, to]);
      });
      at = tag.end;
      const local = localName(tag.name);
      if (closing) continue;
      if (xml && tag.selfClosing) {
        if (local === "style") found.elements.push([open, tag.end]);
        continue;
      }
      if (local === "style") {
        at = endOfElement(markup, tag.name, tag.end);
        found.elements.push([open, at]);
      } else if (!xml && RAW_TEXT.has(local)) {
        at = local === "plaintext" ? markup.length : endOfElement(markup, tag.name, tag.end);
      }
    } else {
      at = open + 1;
    }
  }
  return found;
}

/** Whether XML `markup` (an SVG icon) holds a `style` attribute or a `<style>` element. */
export function hasInlineStyle(markup: string): boolean {
  const { attributes, elements } = findInlineStyles(markup, true);
  return attributes.length > 0 || elements.length > 0;
}

/**
 * `html` with no inline style left for a parser to report: each `<style>` element removed whole
 * (its contents are CSS, never text to keep), and each `style` attribute renamed `data-style`,
 * which a sanitiser that keeps no `data-*` attribute then drops. Everything else, attribute
 * values and text included, is kept byte for byte.
 */
export function neutralizeInlineStyles(html: string): string {
  const { attributes, elements } = findInlineStyles(html, false);
  if (attributes.length === 0 && elements.length === 0) return html;
  const edits = [
    ...attributes.map(([from, to]) => ({ from, to, text: "data-style" })),
    ...elements.map(([from, to]) => ({ from, to, text: "" })),
  ].sort((a, b) => a.from - b.from);
  let out = "";
  let at = 0;
  for (const edit of edits) {
    if (edit.from < at) continue; // An attribute inside a removed element.
    out += html.slice(at, edit.from) + edit.text;
    at = edit.to;
  }
  return out + html.slice(at);
}
