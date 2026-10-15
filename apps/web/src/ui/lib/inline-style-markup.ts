/**
 * Inline styles in untrusted markup, found before it is parsed. The shell's
 * Content-Security-Policy refuses `style` attributes and un-nonced `<style>` elements, and the
 * browser reports one as soon as markup carrying it is parsed, even into an inert document (as
 * a sanitiser's `DOMParser` does). So markup is checked or rewritten as a string first.
 *
 * The tag reader approximates the HTML parser of a `DOMParser` document (scripting disabled):
 * an attribute's value, quoted (`"…"`, `'…'`) or not, is never mistaken for a name; text outside
 * tags is never touched; comments (`<!--…-->`, `<!-->`, `--!>`), bogus comments (`<!…>`, `<?…>`,
 * and `<![CDATA[…>` outside SVG and MathML), CDATA sections inside them, and the contents of
 * raw-text elements (`<script>`, `<textarea>`, `<title>`, … outside SVG and MathML) are skipped.
 * Inside `<svg>` and `<math>`, `/>` closes an element.
 *
 * It is an approximation, so every uncertainty resolves toward keeping content: a style it
 * misses reaches the sanitiser, which drops it (the policy refuses it anyway, and only a
 * violation report results), while a `<style>` element is removed only through a matching end
 * tag with nothing but text before it. Lost content is never an acceptable trade for a report.
 */

/** Elements whose contents an HTML parser reads as text up to their own end tag (outside SVG and MathML). */
const RAW_TEXT = new Set(["script", "textarea", "title", "xmp", "iframe", "noembed", "noframes", "plaintext"]);

/** Start tags that end SVG or MathML content and return to HTML. */
const BREAKOUT = new Set([
  "b", "big", "blockquote", "body", "br", "center", "code", "dd", "div", "dl", "dt", "em", "embed", "h1", "h2", "h3", "h4", "h5", "h6",
  "head", "hr", "i", "img", "li", "listing", "menu", "meta", "nobr", "ol", "p", "pre", "ruby", "s", "small", "span", "strong", "strike",
  "sub", "sup", "table", "tt", "u", "ul", "var",
]);

interface Found {
  /** A `style` attribute's name: [start, end) of the name only. */
  readonly attributes: (readonly [number, number])[];
  /** A `<style>` element, or only its start tag: [start, end) of what to remove. */
  readonly elements: (readonly [number, number])[];
}

const isSpace = (char: string | undefined) => char === " " || char === "\t" || char === "\n" || char === "\r" || char === "\f";
const isLetter = (char: string | undefined) => char !== undefined && /[A-Za-z]/.test(char);

/** The local name of a tag name (`svg:style` → `style`), lowercased. */
const localName = (name: string) => name.slice(name.lastIndexOf(":") + 1).toLowerCase();

/** The end of the first match of `pattern` at or after `from`, or -1. */
function endOf(markup: string, pattern: RegExp, from: number): { index: number; end: number } | null {
  const search = new RegExp(pattern.source, `${pattern.flags.replace("g", "")}g`);
  search.lastIndex = from;
  const match = search.exec(markup);
  return match === null ? null : { index: match.index, end: match.index + match[0].length };
}

/** Where `name`'s end tag (`</name` then a space, `/` or `>`) starts and ends, at or after `from`. */
function endTag(markup: string, name: string, from: number): { index: number; end: number } | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const found = endOf(markup, new RegExp(`</${escaped}(?=[\\s/>])`, "i"), from);
  if (found === null) return null;
  const close = markup.indexOf(">", found.index);
  return close === -1 ? null : { index: found.index, end: close + 1 };
}

/**
 * Read one tag starting at `start` (`markup[start]` is `<`, then a letter, or `/` and a letter):
 * its name, attributes (each name's range), and where it ends (past `>`, or the end of `markup`).
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

/** Past the first `>` at or after `from`, or the end of `markup`. */
function pastGreaterThan(markup: string, from: number): number {
  const end = markup.indexOf(">", from);
  return end === -1 ? markup.length : end + 1;
}

/**
 * Every inline style in `markup`: `style` attribute names, and `<style>` elements to remove.
 * `xml` reads an XML document (an SVG icon): every element is foreign, `/>` closes it, and
 * comments end only at `-->`.
 */
function findInlineStyles(markup: string, xml: boolean): Found {
  const found: Found = { attributes: [], elements: [] };
  // The open SVG and MathML elements (HTML mode); in XML everything is foreign.
  const foreignStack: string[] = [];
  const inForeign = () => xml || foreignStack.length > 0;
  let at = 0;
  while (at < markup.length) {
    const open = markup.indexOf("<", at);
    if (open === -1) break;
    const next = markup[open + 1];
    if (markup.startsWith("<!--", open)) {
      if (xml) {
        const end = markup.indexOf("-->", open + 4);
        at = end === -1 ? markup.length : end + 3;
      } else if (markup.startsWith("<!-->", open)) {
        at = open + 5;
      } else if (markup.startsWith("<!--->", open)) {
        at = open + 6;
      } else {
        at = endOf(markup, /--!?>/, open + 4)?.end ?? markup.length;
      }
    } else if (markup.startsWith("<![CDATA[", open) && inForeign()) {
      const end = markup.indexOf("]]>", open + 9);
      at = end === -1 ? markup.length : end + 3;
    } else if (next === "!" || next === "?" || (next === "/" && !isLetter(markup[open + 2]) && !xml)) {
      // A bogus comment (a doctype, `<![CDATA[` in HTML, `<?…>`, `</` and no name) ends at the first `>`.
      at = pastGreaterThan(markup, open + 2);
    } else if (isLetter(next) || (next === "/" && isLetter(markup[open + 2]))) {
      const closing = next === "/";
      const tag = readTag(markup, open, (name, from, to) => {
        if (!closing && name.toLowerCase() === "style") found.attributes.push([from, to]);
      });
      at = tag.end;
      const local = localName(tag.name);
      if (closing) {
        const depth = foreignStack.lastIndexOf(local);
        if (!xml && depth !== -1) foreignStack.length = depth;
        continue;
      }
      const foreign = inForeign();
      if (foreign && !xml && BREAKOUT.has(local)) foreignStack.length = 0;
      if (!xml && (local === "svg" || local === "math") && !tag.selfClosing) {
        foreignStack.push(local);
        continue;
      }
      if (local === "style") {
        if (inForeign() && tag.selfClosing) {
          // An empty element: only the tag goes.
          found.elements.push([open, tag.end]);
          continue;
        }
        // The whole element only when its end tag follows with nothing but text before it (as an
        // HTML parser's raw text or an SVG style's text ends there); otherwise only its start tag,
        // and what follows is read on as markup.
        const close = endTag(markup, tag.name, tag.end);
        if (close !== null && !markup.slice(tag.end, close.index).includes("<")) {
          found.elements.push([open, close.end]);
          at = close.end;
        } else {
          found.elements.push([open, tag.end]);
        }
      } else if (!inForeign() && RAW_TEXT.has(local)) {
        // Text to its end tag (or to the end, as the parser reads it): nothing in it is markup.
        at = local === "plaintext" ? markup.length : (endTag(markup, tag.name, tag.end)?.end ?? markup.length);
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
 * `html` with as few inline styles left for a parser to report as can be found safely: each
 * `<style>` element removed (whole when its extent is certain, else only its start tag), and each
 * `style` attribute renamed `data-style`, which a sanitiser that keeps no `data-*` attribute then
 * drops. Everything else, attribute values and text included, is kept byte for byte.
 */
export function neutralizeInlineStyles(html: string): string {
  const { attributes, elements } = findInlineStyles(html, false);
  if (attributes.length === 0 && elements.length === 0) return html;
  const edits = [
    ...attributes.map(([from, to]) => ({ from, to, text: "data-style" })),
    ...elements.map(([from, to]) => ({ from, to, text: "" })),
  ].sort((a, b) => a.from - b.from || b.to - a.to);
  let out = "";
  let at = 0;
  for (const edit of edits) {
    if (edit.from < at) continue; // An attribute inside a removed tag.
    out += html.slice(at, edit.from) + edit.text;
    at = edit.to;
  }
  return out + html.slice(at);
}
