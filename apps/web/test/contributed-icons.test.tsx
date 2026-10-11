// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { MAX_ICON_BYTES } from "@deck/module-sdk";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Icon, sanitizeIconSvg, setContributedIcons } from "@/ui";

/** Icons modules contribute as SVG: rebuilt from an allowlist, and rendered by `Icon` like curated ones. */

const TEST_FILE_URL = import.meta.url;
const NS = 'xmlns="http://www.w3.org/2000/svg"';
const PATH = '<path d="M4 4h16v16H4z"/>';
const svg = (inner: string = PATH, attributes = "") => `<svg ${NS} viewBox="0 0 24 24"${attributes}>${inner}</svg>`;
const XLINK = ' xmlns:xlink="http://www.w3.org/1999/xlink"';

afterEach(() => {
  cleanup();
  act(() => setContributedIcons(undefined));
  vi.restoreAllMocks();
});

describe("sanitizeIconSvg", () => {
  it("keeps shapes, paint servers and local references", () => {
    const icon = sanitizeIconSvg(
      svg(`<defs><linearGradient id="g"><stop offset="0" stop-color="currentColor"/></linearGradient></defs><title>Box</title>${PATH}<use href="#a"/><g id="a" fill="url(#g)"><circle r="2"/></g>`),
    )!;
    expect(icon.localName).toBe("svg");
    expect(icon.querySelector("path")?.getAttribute("d")).toBe("M4 4h16v16H4z");
    expect(icon.querySelector("use")?.getAttribute("href")).toBe("#a");
    expect(icon.querySelector("g#a")?.getAttribute("fill")).toBe("url(#g)");
    expect(icon.querySelector("title")?.textContent).toBe("Box");
  });

  it("drops attributes outside the allowlist, comments and stray text", () => {
    const icon = sanitizeIconSvg(svg(`<!-- hi --><path class="x" data-x="1" aria-label="y" d="M0 0"/>text`))!;
    // Serialised into an HTML page, as `Icon` renders it: inline <svg> is SVG there without xmlns.
    expect(icon.outerHTML).toBe('<svg viewBox="0 0 24 24"><path d="M0 0"></path></svg>');
  });

  it.each([
    ["<script>", svg(`${PATH}<script>alert(1)</script>`)],
    ["an event handler", svg(PATH, ' onload="alert(1)"')],
    ["<style> with body{display:none}", svg(`<style>body{display:none}</style>${PATH}`)],
    ["<style> with @import", svg(`<style>@import "https://evil.example/x.css";</style>${PATH}`)],
    ["a u\\72 l( escape in a <style>", svg(`<style>path{fill:u\\72 l(https://evil.example/x)}</style>${PATH}`)],
    ["a u\\72 l( escape in an attribute", svg(`<path fill="u\\72 l(https://evil.example/x)" d="M0 0"/>`)],
    ["a style attribute", svg(`<path style="fill: red" d="M0 0"/>`)],
    ["a <foreignObject>", svg(`<foreignObject><div>hi</div></foreignObject>`)],
    ["an external <image>", svg(`<image href="https://evil.example/x.png"/>`)],
    ["an <feImage>", svg(`<filter id="f"><feImage href="https://evil.example/x.png"/></filter>`)],
    ["an <a href>", svg(`<a href="https://evil.example/">${PATH}</a>`)],
    ["a gradient href to another document", svg(`<defs><linearGradient id="g" href="https://evil.example/g.svg#x"/></defs>${PATH}`)],
    ["a <use> pointing at another document", svg(`<use href="sprite.svg#a"/>`)],
    ["a <use> pointing at a data: URL", svg(`<use href="data:image/svg+xml,x#a"/>`)],
    ["an xlink:href <use> pointing outside", svg(`<use xlink:href="https://evil.example/s.svg#a"/>`, XLINK)],
    ["a url() fill pointing outside", svg(`<path fill="url(https://evil.example/x#g)" d="M0 0"/>`)],
    ["a url() in an attribute that takes none", svg(`<path d="url(#g)"/>`)],
    ["image-set() in a <rect> mask", svg(`<rect width="4" height="4" mask="image-set('https://evil.example/x.png' 1x)"/>`)],
    ["image-set() in a <g> fill", svg(`<g fill="image-set('https://evil.example/x.png' 1x)">${PATH}</g>`)],
    ["cross-fade() in a mask", svg(`<rect mask="cross-fade(url(#a), url(#b), 50%)"/>`)],
    ["-webkit-image-set() in a clip-path", svg(`<rect clip-path="-webkit-image-set('https://evil.example/x.png' 1x)"/>`)],
    ["image() in a stroke", svg(`<path stroke="image('https://evil.example/x.png')" d="M0 0"/>`)],
    ["a function in a stop-color", svg(`<linearGradient id="g"><stop stop-color="var(--x)"/></linearGradient>`)],
    ["a function in a geometry attribute", svg(`<rect width="calc(1px + 2px)"/>`)],
    ["an unknown function in a transform", svg(`<g transform="perspective(10px)">${PATH}</g>`)],
    ["a doctype (entities)", `<!DOCTYPE svg [<!ENTITY x "y">]>${svg()}`],
    ["markup that is not SVG", "<div>not an icon</div>"],
    ["an <svg> outside the SVG namespace", '<svg viewBox="0 0 1 1"><path d="M0 0"/></svg>'],
    ["markup that is not well-formed", `<svg ${NS}><path></svg>`],
    ["markup over the size bound", svg(`<desc>${"x".repeat(MAX_ICON_BYTES)}</desc>`)],
  ])("refuses %s", (_label, markup) => {
    expect(sanitizeIconSvg(markup)).toBeNull();
  });

  it("keeps each attribute's allowed values: none, colours, local references and basic transforms", () => {
    const icon = sanitizeIconSvg(
      svg(
        `<defs><linearGradient id="g"><stop stop-color="hsl(120deg 50% 50%)"/><stop stop-color="currentColor"/></linearGradient><mask id="m"/></defs>` +
          `<rect fill="#abc" stroke="none" mask="none" width="4"/><path fill="rgb(1 2 3 / 50%)" stroke="currentColor" mask="url(#m)" transform="rotate(45 12 12) translate(1,2)" d="M0 0"/>`,
      ),
    )!;
    expect(icon).not.toBeNull();
    expect(icon.querySelector("path")!.getAttribute("fill")).toBe("rgb(1 2 3 / 50%)");
    expect(icon.querySelector("path")!.getAttribute("transform")).toBe("rotate(45 12 12) translate(1,2)");
    expect(icon.querySelector("rect")!.getAttribute("mask")).toBe("none");
  });

  it("stores local references canonically, whitespace trimmed", () => {
    const icon = sanitizeIconSvg(svg(`<defs><linearGradient id="g"/></defs><path fill=" url( #g ) " clip-path="url(#g )" mask=" url(#g)" d="M0 0"/><use href=" #g "/>`))!;
    const path = icon.querySelector("path")!;
    expect([path.getAttribute("fill"), path.getAttribute("clip-path"), path.getAttribute("mask")]).toEqual(["url(#g)", "url(#g)", "url(#g)"]);
    expect(icon.querySelector("use")!.getAttribute("href")).toBe("#g");
  });

  it("does not use DOMPurify (it stays off the shell's eager load path)", () => {
    const source = readFileSync(fileURLToPath(new URL("../src/ui/lib/contributed-icons.ts", TEST_FILE_URL)), "utf8");
    expect(source).not.toMatch(/dompurify/i);
  });
});

describe("Icon with contributed icons", () => {
  it("renders a contributed icon at its size, hidden from assistive tech", () => {
    act(() => setContributedIcons({ "mod/box": svg() }));
    const { container } = render(<Icon name="mod/box" size={20} className="text-primary" />);
    const span = container.querySelector('[data-slot="icon"]')!;
    expect(span.getAttribute("aria-hidden")).toBe("true");
    expect(span.className).toContain("text-primary");
    const icon = span.querySelector("svg")!;
    expect(icon.getAttribute("width")).toBe("20");
    expect(icon.getAttribute("height")).toBe("20");
    expect(icon.querySelector("path")).not.toBeNull();
  });

  it("gives each rendering its own ids, with its references rewritten to match", () => {
    act(() => setContributedIcons({ "mod/grad": svg(`<defs><linearGradient id="g"/><clipPath id="c"><rect width="4" height="4"/></clipPath></defs><path fill="url(#g)" clip-path="url(#c)" d="M0 0"/><use href="#c"/>`) }));
    const { container } = render(
      <>
        <Icon name="mod/grad" />
        <Icon name="mod/grad" />
      </>,
    );
    const ids = [...container.querySelectorAll("[id]")].map((element) => element.id);
    expect(ids).toHaveLength(4);
    expect(new Set(ids).size).toBe(4);
    for (const icon of container.querySelectorAll("svg")) {
      const gradient = icon.querySelector("linearGradient")!.id;
      const clip = icon.querySelector("clipPath")!.id;
      expect(icon.querySelector("path")!.getAttribute("fill")).toBe(`url(#${gradient})`);
      expect(icon.querySelector("path")!.getAttribute("clip-path")).toBe(`url(#${clip})`);
      expect(icon.querySelector("use")!.getAttribute("href")).toBe(`#${clip}`);
    }
  });

  it("rewrites references written with whitespace to the scoped ids too", () => {
    act(() => setContributedIcons({ "mod/ws": svg(`<defs><linearGradient id="g"/></defs><path fill=" url( #g ) " clip-path=" url(#g)" mask="url(#g )" d="M0 0"/>`) }));
    const { container } = render(<Icon name="mod/ws" />);
    const id = container.querySelector("linearGradient")!.id;
    expect(id).not.toBe("g");
    const path = container.querySelector("path")!;
    for (const name of ["fill", "clip-path", "mask"]) expect(path.getAttribute(name), name).toBe(`url(#${id})`);
  });

  it("renders the fallback icon for a refused or unknown contributed icon", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    act(() => setContributedIcons({ "mod/bad": svg("<foreignObject/>") }));
    const { container } = render(<Icon name="mod/bad" />);
    // The fallback is a curated (Lucide) icon: an <svg> with the lucide class, no wrapper span.
    expect(container.querySelector("span[data-slot=icon]")).toBeNull();
    expect(container.querySelector("svg.lucide")).not.toBeNull();
  });

  it("re-renders when the manifest's icons arrive", () => {
    const { container } = render(<Icon name="mod/late" />);
    expect(container.querySelector("span[data-slot=icon]")).toBeNull();
    act(() => setContributedIcons({ "mod/late": svg() }));
    expect(container.querySelector("span[data-slot=icon] svg")).not.toBeNull();
  });

  it("never lets a contributed icon shadow a curated one", () => {
    act(() => setContributedIcons({ boxes: svg() }));
    const { container } = render(<Icon name="boxes" />);
    expect(container.querySelector("span[data-slot=icon]")).toBeNull();
  });
});
