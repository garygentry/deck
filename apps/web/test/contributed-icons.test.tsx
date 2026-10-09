// @vitest-environment jsdom
import { MAX_ICON_BYTES } from "@deck/module-sdk";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Icon, sanitizeIconSvg, setContributedIcons } from "@/ui";

/** Icons modules contribute as SVG: checked, sanitised, and rendered by `Icon` like curated ones. */

const PATH = '<path d="M4 4h16v16H4z"/>';
const svg = (inner: string = PATH, attributes = "") => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"${attributes}>${inner}</svg>`;

afterEach(() => {
  cleanup();
  act(() => setContributedIcons(undefined));
  vi.restoreAllMocks();
});

describe("sanitizeIconSvg", () => {
  it("keeps a plain icon, and does not refuse a <use> of a local #id", () => {
    const icon = sanitizeIconSvg(svg(`${PATH}<use href="#a"/><g id="a"><circle r="2"/></g>`))!;
    expect(icon.localName).toBe("svg");
    expect(icon.querySelector("path")?.getAttribute("d")).toBe("M4 4h16v16H4z");
    expect(icon.querySelector("circle")).not.toBeNull();
  });

  it("drops scripts and event handlers", () => {
    const icon = sanitizeIconSvg(svg(`${PATH}<script>alert(1)</script>`, ' onload="alert(1)"'))!;
    expect(icon).not.toBeNull();
    expect(icon.outerHTML).not.toMatch(/script|onload|alert/);
  });

  it.each([
    ["a <foreignObject>", svg(`<foreignObject><div>hi</div></foreignObject>`)],
    ["a <foreignObject> in another case", svg(`<foreignobject/>`)],
    ["a <use> pointing at another document", svg(`<use href="sprite.svg#a"/>`)],
    ["a <use> pointing at a data: URL", svg(`<use href="data:image/svg+xml,&lt;svg/&gt;#a"/>`)],
    ["an xlink:href <use> pointing outside", svg(`<use xlink:href="https://evil.example/s.svg#a"/>`, ' xmlns:xlink="http://www.w3.org/1999/xlink"')],
    ["a style attribute with url(", svg(`<path style="fill: URL(https://evil.example/x)" d="M0 0"/>`)],
    ["a <style> with url(", svg(`<style>path { fill: url ( "https://evil.example/x" ) }</style>${PATH}`)],
    ["markup that is not SVG", "<div>not an icon</div>"],
    ["markup that is not well-formed", "<svg><path></svg>"],
    ["markup over the size bound", svg(`<desc>${"x".repeat(MAX_ICON_BYTES)}</desc>`)],
  ])("refuses %s", (_label, markup) => {
    expect(sanitizeIconSvg(markup)).toBeNull();
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
