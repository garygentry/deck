import { describe, expect, it } from "vitest";

import { hasInlineStyle, neutralizeInlineStyles } from "@/ui/lib/inline-style-markup.js";

describe("neutralizeInlineStyles (HTML)", () => {
  it("renames style attribute names only, keeping values, text and other attributes byte for byte", () => {
    expect(neutralizeInlineStyles(`<a href="/style/x" title='a style="b"' style="c">style=1</a>`)).toBe(`<a href="/style/x" title='a style="b"' data-style="c">style=1</a>`);
    expect(neutralizeInlineStyles(`<img alt="x > style=y" STYLE = 'z' src=style.png>`)).toBe(`<img alt="x > style=y" data-style = 'z' src=style.png>`);
    expect(neutralizeInlineStyles(`<p data-style-ish="1" stylesheet="x">a</p>`)).toBe(`<p data-style-ish="1" stylesheet="x">a</p>`);
    expect(neutralizeInlineStyles(`<b title="x"style="y">t</b>`)).toBe(`<b title="x"data-style="y">t</b>`);
  });

  it("removes <style> elements whole, attributes and all, and leaves comments and raw text alone", () => {
    expect(neutralizeInlineStyles(`a<style media="x" style="y">p{color:red}</style >b`)).toBe("ab");
    expect(neutralizeInlineStyles(`a<STYLE/>p{}</style>b`)).toBe("ab");
    expect(neutralizeInlineStyles(`a<style>unterminated`)).toBe("a");
    expect(neutralizeInlineStyles(`<!-- <p style="x"> --><textarea><b style="x"></textarea>`)).toBe(`<!-- <p style="x"> --><textarea><b style="x"></textarea>`);
    expect(neutralizeInlineStyles(`1 < 2 &lt;style&gt;`)).toBe(`1 < 2 &lt;style&gt;`);
  });
});

describe("hasInlineStyle (XML)", () => {
  it("finds a style attribute or <style> element, quote-aware", () => {
    expect(hasInlineStyle(`<svg><path style="x"/></svg>`)).toBe(true);
    expect(hasInlineStyle(`<svg><svg:style>p{}</svg:style></svg>`)).toBe(true);
    expect(hasInlineStyle(`<svg><title>style</title><path id="style" d="style=1"/></svg>`)).toBe(false);
    expect(hasInlineStyle(`<svg><!-- style="x" --><![CDATA[<p style="x">]]><title/><path style="y"/></svg>`)).toBe(true);
    expect(hasInlineStyle(`<svg><!-- <p style="x"> --><![CDATA[<p style="x">]]></svg>`)).toBe(false);
  });
});
