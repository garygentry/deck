import { describe, expect, it } from "vitest";

import { hasInlineStyle, neutralizeInlineStyles } from "@/ui/lib/inline-style-markup.js";

describe("neutralizeInlineStyles (HTML)", () => {
  it("renames style attribute names only, keeping values, text and other attributes byte for byte", () => {
    expect(neutralizeInlineStyles(`<a href="/style/x" title='a style="b"' style="c">style=1</a>`)).toBe(`<a href="/style/x" title='a style="b"' data-style="c">style=1</a>`);
    expect(neutralizeInlineStyles(`<img alt="x > style=y" STYLE = 'z' src=style.png>`)).toBe(`<img alt="x > style=y" data-style = 'z' src=style.png>`);
    expect(neutralizeInlineStyles(`<p data-style-ish="1" stylesheet="x">a</p>`)).toBe(`<p data-style-ish="1" stylesheet="x">a</p>`);
    expect(neutralizeInlineStyles(`<b title="x"style="y">t</b>`)).toBe(`<b title="x"data-style="y">t</b>`);
  });

  it("removes a <style> element whole only through its end tag, with nothing but text before it", () => {
    expect(neutralizeInlineStyles(`a<style media="x" style="y">p{color:red}</style >b`)).toBe("ab");
    // As HTML, `/>` closes nothing: the raw text runs to the end tag.
    expect(neutralizeInlineStyles(`a<STYLE/>p{}</style>b`)).toBe("ab");
  });

  it("never removes content past where a parser ends the element: unterminated, or markup before the end tag", () => {
    expect(neutralizeInlineStyles(`a<style>unterminated <p>kept</p>`)).toBe("aunterminated <p>kept</p>");
    // Markup before the end tag: its extent depends on the parse, so the sanitiser decides.
    expect(neutralizeInlineStyles(`<style>x <p style="y">kept</p></style>`)).toBe(`<style>x <p data-style="y">kept</p></style>`);
  });

  it("honours /> inside SVG and MathML, and returns to HTML after them", () => {
    expect(neutralizeInlineStyles(`<svg><style /></svg>\n<h1>Important</h1>`)).toBe(`<svg></svg>\n<h1>Important</h1>`);
    expect(neutralizeInlineStyles(`<math><style/></math><p>next</p>`)).toBe(`<math></math><p>next</p>`);
    expect(neutralizeInlineStyles(`<svg><style>path{}</style></svg><style/>x</style>`)).toBe(`<svg></svg>`);
    // A breakout tag (here <p>) ends SVG content; a <style/> after it is HTML again.
    expect(neutralizeInlineStyles(`<svg><p>a</p><style/>b</style>c`)).toBe(`<svg><p>a</p>c`);
  });

  it("reads noscript contents as markup (a DOMParser document runs no script)", () => {
    expect(neutralizeInlineStyles(`<noscript><style>p{color:red}</style><p style="color:red">fallback</p></noscript>`)).toBe(
      `<noscript><p data-style="color:red">fallback</p></noscript>`,
    );
  });

  it("ends comments as HTML does: <!-->, <!--->, --> and --!>", () => {
    expect(neutralizeInlineStyles(`<!--> <p style="x">a</p> -->`)).toBe(`<!--> <p data-style="x">a</p> -->`);
    expect(neutralizeInlineStyles(`<!---> <p style="x">a</p>`)).toBe(`<!---> <p data-style="x">a</p>`);
    expect(neutralizeInlineStyles(`<!-- <p style="x"> --!> <p style="y">`)).toBe(`<!-- <p style="x"> --!> <p data-style="y">`);
    expect(neutralizeInlineStyles(`<!-- <p style="x"> --> <p style="y">`)).toBe(`<!-- <p style="x"> --> <p data-style="y">`);
  });

  it("reads <![CDATA[ as a bogus comment to the first > in HTML, and as CDATA inside SVG", () => {
    expect(neutralizeInlineStyles(`<![CDATA[ > <p style="x"> ]]>`)).toBe(`<![CDATA[ > <p data-style="x"> ]]>`);
    expect(neutralizeInlineStyles(`<svg><![CDATA[ > <p style="x"> ]]></svg>`)).toBe(`<svg><![CDATA[ > <p style="x"> ]]></svg>`);
  });

  it("reads title and textarea as raw text in HTML but as markup inside SVG and MathML", () => {
    expect(neutralizeInlineStyles(`<title><img style="x"></title><textarea><b style="y"></textarea>`)).toBe(`<title><img style="x"></title><textarea><b style="y"></textarea>`);
    expect(neutralizeInlineStyles(`<svg><title><img style="x"></title></svg>`)).toBe(`<svg><title><img data-style="x"></title></svg>`);
    expect(neutralizeInlineStyles(`<math><textarea><b style="y"></textarea></math>`)).toBe(`<math><textarea><b data-style="y"></textarea></math>`);
  });

  it("leaves text alone", () => {
    expect(neutralizeInlineStyles(`1 < 2 &lt;style&gt;`)).toBe(`1 < 2 &lt;style&gt;`);
  });
});

describe("hasInlineStyle (XML)", () => {
  it("finds a style attribute or <style> element, quote-aware", () => {
    expect(hasInlineStyle(`<svg><path style="x"/></svg>`)).toBe(true);
    expect(hasInlineStyle(`<svg><svg:style>p{}</svg:style></svg>`)).toBe(true);
    expect(hasInlineStyle(`<svg><style/></svg>`)).toBe(true);
    expect(hasInlineStyle(`<svg><title>style</title><path id="style" d="style=1"/></svg>`)).toBe(false);
    expect(hasInlineStyle(`<svg><!-- style="x" --><![CDATA[<p style="x">]]><title/><path style="y"/></svg>`)).toBe(true);
    expect(hasInlineStyle(`<svg><!-- <p style="x"> --><![CDATA[<p style="x">]]></svg>`)).toBe(false);
  });
});
