// @vitest-environment jsdom
import type { StatusMapData, UiWidgetInstance } from "@deck/module-sdk";
import { cleanup, render, screen, within } from "@testing-library/react";
import { Suspense, type ComponentType, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetQueryClient } from "../src/data/query-client.js";
import { KeyValueWidget, MeterWidget, StatGridWidget, StatWidget } from "../src/features/core-widgets/ValueWidgets.js";
import { LinkTilesWidget, ListWidget, StatusGridWidget } from "../src/features/core-widgets/ListWidgets.js";
import MarkdownWidget from "../src/features/core-widgets/MarkdownWidget.js";
import { StatusMapsOverride } from "../src/features/core-widgets/status-maps.js";
import TableWidget from "../src/features/core-widgets/TableWidget.js";
import type { WidgetProps } from "../src/registry/registry.js";

/**
 * The generic widgets (`core/…`) against their accessibility contract: each shows its value
 * with the pattern's roles and names, tones a value only through a status map (always with an
 * icon and its text), and says so when given a value it cannot show.
 */

const MAPS: Record<string, StatusMapData> = {
  load: { rules: [{ lt: 60, tone: "ok" }, { lt: 85, tone: "warn" }, { tone: "danger" }] },
  state: { values: { running: "ok", stopped: "danger" } },
  // An exact entry for "01", and a rule every other value falls back to.
  code: { values: { "01": "warn" }, rules: [{ tone: "ok" }] },
  any: { rules: [{ tone: "danger" }] },
};

function widget(type: string, title?: string): UiWidgetInstance {
  return { id: "widget:ui/lab.w", type, ...(title === undefined ? {} : { title }), source: null, options: {}, span: 1, rows: 1 };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- each widget's own options type
function show(Component: ComponentType<WidgetProps<any>>, type: string, value: unknown, options: Record<string, unknown> = {}, title: string | undefined = "Widget") {
  const wrap = (node: ReactNode) => (
    <StatusMapsOverride.Provider value={MAPS}>
      <Suspense fallback={null}>{node}</Suspense>
    </StatusMapsOverride.Provider>
  );
  return render(wrap(<Component value={value} options={options} freshness={null} widget={widget(type, title)} />));
}

beforeEach(() => {
  // The widgets read the UI manifest (for its status maps); none is served here.
  vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 404 })));
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetQueryClient();
});

const unexpected = () => screen.getByRole("alert");

describe("core/stat", () => {
  it("shows the value formatted, as a definition named by its label", () => {
    show(StatWidget, "core/stat", 42.26, { label: "Load", format: "percent" });
    expect(screen.getByRole("term")).toHaveTextContent("Load");
    expect(screen.getByRole("definition")).toHaveTextContent("42.3%");
  });

  it("is labelled by the widget's title for assistive tech when it sets no label", () => {
    show(StatWidget, "core/stat", "Eaton 5P", {}, "Model");
    const term = screen.getByRole("term");
    expect(term).toHaveTextContent("Model");
    expect(within(term).getByText("Model")).toHaveClass("sr-only");
  });

  it("takes its tone from the status map, with the tone's icon", () => {
    const { container } = show(StatWidget, "core/stat", 93, { statusMap: "load" });
    const tile = container.querySelector('[data-slot="stat-tile"]')!;
    expect(tile).toHaveAttribute("data-tone", "danger");
    expect(tile.querySelector("svg")).not.toBeNull();
  });

  it("stays untoned, with no icon, for an undeclared map or no match", () => {
    const { container } = show(StatWidget, "core/stat", 93, { statusMap: "nope" });
    const tile = container.querySelector('[data-slot="stat-tile"]')!;
    expect(tile).toHaveAttribute("data-tone", "neutral");
    expect(tile.querySelector("svg")).toBeNull();
  });

  it("says what it shows when the value is a list", () => {
    show(StatWidget, "core/stat", [1, 2]);
    expect(unexpected()).toHaveTextContent("core/stat shows a number or text; this widget's value is a list.");
  });
});

describe("core/stat-grid", () => {
  it("shows every scalar key by default, and the chosen fields with their labels and formats", () => {
    show(StatGridWidget, "core/stat-grid", { load: 42, model: "Eaton", nested: { a: 1 } });
    expect(screen.getAllByRole("term").map((term) => term.textContent)).toEqual(["load", "model"]);
    cleanup();
    show(StatGridWidget, "core/stat-grid", { ups: { load: 70, runtime: 5_460 } }, {
      items: [{ field: "ups.load", label: "Load", format: "percent", statusMap: "load" }, { field: "ups.runtime", label: "Runtime", format: "duration" }, { field: "missing", label: "Missing" }],
    });
    expect(screen.getAllByRole("term").map((term) => term.textContent)).toEqual(["Load", "Runtime", "Missing"]);
    expect(screen.getAllByRole("definition").map((definition) => definition.textContent)).toEqual(["70%", "1h 31m", "No value"]);
    expect(document.querySelector('[data-slot="stat-tile"]')).toHaveAttribute("data-tone", "warn");
  });

  it("needs an object", () => {
    show(StatGridWidget, "core/stat-grid", 3);
    expect(unexpected()).toHaveTextContent("shows an object");
  });
});

describe("core/meter", () => {
  it("is a meter with its value, maximum and value text, named by its label", () => {
    show(MeterWidget, "core/meter", 87, { label: "Battery" });
    const meter = screen.getByRole("meter", { name: "Battery" });
    expect(meter).toHaveAttribute("aria-valuenow", "87");
    expect(meter).toHaveAttribute("aria-valuemax", "100");
    expect(meter).toHaveAttribute("aria-valuetext", "87%");
  });

  it("formats its value against a maximum, and takes a tone from its map", () => {
    const { container } = show(MeterWidget, "core/meter", "180", { label: "Draw", max: 200, format: "number", unit: "W", statusMap: "load" });
    const meter = screen.getByRole("meter", { name: "Draw" });
    expect(meter).toHaveAttribute("aria-valuetext", "180 W of 200 W");
    expect(screen.getByText("180 W")).toBeInTheDocument();
    expect(container.querySelector('[data-slot="meter"]')).toHaveAttribute("data-tone", "danger");
  });

  it("needs a number", () => {
    show(MeterWidget, "core/meter", "lots");
    expect(unexpected()).toHaveTextContent("shows a number; this widget's value is text.");
  });
});

describe("core/key-value", () => {
  it("lists every key's value, and a status-mapped field as a badge with its text", () => {
    show(KeyValueWidget, "core/key-value", { name: "media", state: "stopped" }, {
      items: [{ field: "name", label: "Service" }, { field: "state", label: "State", statusMap: "state" }, { field: "host", label: "Host" }],
    });
    expect(screen.getAllByRole("term").map((term) => term.textContent)).toEqual(["Service", "State", "Host"]);
    const [service, state, host] = screen.getAllByRole("definition");
    expect(service).toHaveTextContent("media");
    expect(state!.querySelector('[data-slot="status-badge"]')).toHaveAttribute("data-tone", "danger");
    expect(state).toHaveTextContent("stopped");
    expect(host).toHaveTextContent("No value");
  });
});

describe("core/list", () => {
  const SERVICES = [
    { name: "media", status: "running", host: "nas-01", url: "/services/nas-01/media" },
    { name: "vendor", status: "stopped", url: "https://vendor.example" },
    { name: "bad", url: "javascript:alert(1)" },
  ];

  it("is a list of rows: title, description, status badge, and a link when the field holds a safe one", () => {
    show(ListWidget, "core/list", SERVICES, { descriptionField: "host", statusField: "status", statusMap: "state", hrefField: "url" }, "Services");
    const list = screen.getByRole("list", { name: "Services" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(3);
    expect(within(list).getByRole("link", { name: "media" })).toHaveAttribute("href", "/services/nas-01/media");
    const external = within(list).getByRole("link", { name: /vendor/ });
    expect(external).toHaveAttribute("target", "_blank");
    expect(external).toHaveAccessibleName("vendor (opens in new tab)");
    // A script URL is never a link.
    expect(within(list).queryByRole("link", { name: "bad" })).toBeNull();
    expect(within(list).getByText("bad")).toBeInTheDocument();
    expect(within(list).getByText("nas-01")).toBeInTheDocument();
    const badges = list.querySelectorAll('[data-slot="status-badge"]');
    expect([...badges].map((badge) => [badge.textContent, badge.getAttribute("data-tone")])).toEqual([["running", "ok"], ["stopped", "danger"]]);
  });

  it("titles text items by themselves, cuts to its limit and says so", () => {
    show(ListWidget, "core/list", ["a", "b", "c"], { limit: 2 }, "Letters");
    expect(within(screen.getByRole("list", { name: "Letters" })).getAllByRole("listitem").map((item) => item.textContent)).toEqual(["a", "b"]);
    expect(screen.getByText("Showing the first 2 of 3.")).toBeInTheDocument();
  });

  it("needs a list", () => {
    show(ListWidget, "core/list", { a: 1 });
    expect(unexpected()).toHaveTextContent("shows a list; this widget's value is an object.");
  });
});

describe("core/table", () => {
  it("is a table captioned by its title, a column per descriptor, the first cells row headers", () => {
    show(TableWidget, "core/table", [{ name: "nas-01", watts: 1234.5, state: "running" }, { name: "lab-pi", state: "stopped" }], {
      columns: [{ field: "name", header: "Outlet" }, { field: "watts", header: "Draw", format: "number", unit: "W", align: "end" }, { field: "state", statusMap: "state" }],
    }, "Outlets");
    const table = screen.getByRole("table", { name: "Outlets" });
    expect(within(table).getAllByRole("columnheader").map((header) => header.textContent)).toEqual(["Outlet", "Draw", "state"]);
    expect(within(table).getAllByRole("rowheader").map((cell) => cell.textContent)).toEqual(["nas-01", "lab-pi"]);
    const [first, second] = within(table).getAllByRole("row").slice(1);
    expect(within(first!).getByText("1,234.5 W")).toHaveClass("text-right");
    expect(within(second!).getByText("None")).toBeInTheDocument();
    expect(table.querySelector('[data-slot="status-badge"][data-tone="danger"]')).toHaveTextContent("stopped");
  });

  it("needs a list of objects", () => {
    show(TableWidget, "core/table", "nope", { columns: [{ field: "name" }] });
    expect(unexpected()).toHaveTextContent("shows a list of objects");
  });
});

describe("core/status-grid", () => {
  it("is a list of tiles, each named by its label with a status badge", () => {
    show(StatusGridWidget, "core/status-grid", [{ name: "media", status: "running", url: "/services/nas-01/media" }, { name: "dns", status: "paused" }], { statusMap: "state", hrefField: "url" }, "States");
    const grid = screen.getByRole("list", { name: "States" });
    expect(within(grid).getAllByRole("listitem")).toHaveLength(2);
    expect(within(grid).getByRole("link", { name: "media" })).toHaveAttribute("href", "/services/nas-01/media");
    const badges = [...grid.querySelectorAll('[data-slot="status-badge"]')].map((badge) => [badge.textContent, badge.getAttribute("data-tone")]);
    // A state the map does not name is neutral, still with its text.
    expect(badges).toEqual([["running", "ok"], ["paused", "neutral"]]);
  });

  it("reads an object of names and states", () => {
    show(StatusGridWidget, "core/status-grid", { media: "running", printer: "stopped" }, { statusMap: "state" }, "States");
    expect(within(screen.getByRole("list", { name: "States" })).getAllByRole("listitem").map((item) => item.textContent)).toEqual(["mediarunning", "printerstopped"]);
  });
});

describe("core/link-tiles", () => {
  it("links each tile; one leaving deck opens in a new tab", () => {
    show(LinkTilesWidget, "core/link-tiles", null, { links: [{ title: "Hosts", href: "/hosts", icon: "server" }, { title: "Vendor", href: "https://vendor.example" }] }, "Shortcuts");
    const grid = screen.getByRole("list", { name: "Shortcuts" });
    expect(within(grid).getByRole("link", { name: "Hosts" })).toHaveAttribute("href", "/hosts");
    expect(within(grid).getByRole("link", { name: /Vendor/ })).toHaveAttribute("target", "_blank");
  });

  it("reads links from its value, leaving out any without a title or a safe href", () => {
    show(LinkTilesWidget, "core/link-tiles", [{ title: "Docs", href: "/docs" }, { title: "Evil", href: "javascript:alert(1)" }, { href: "/x" }], {}, "Links");
    expect(within(screen.getByRole("list", { name: "Links" })).getAllByRole("link").map((link) => link.textContent)).toEqual(["Docs"]);
  });
});

describe("core/markdown", () => {
  it("renders markdown from its options, sanitised", () => {
    const { container } = show(MarkdownWidget, "core/markdown", null, {
      content: "**Bold** [docs](/docs) [vendor](https://vendor.example) [x](javascript:alert(1))\n\n<script>window.pwned = 1</script><img src=x onerror=alert(1)>",
    });
    expect(screen.getByText("Bold").tagName).toBe("STRONG");
    expect(screen.getByRole("link", { name: "docs" })).toHaveAttribute("href", "/docs");
    expect(screen.getByRole("link", { name: "vendor" })).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.queryByRole("link", { name: "x" })).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")?.getAttribute("onerror")).toBeFalsy();
  });

  it("renders its value when it has no content of its own, and needs text", () => {
    show(MarkdownWidget, "core/markdown", "# Heading from data");
    expect(screen.getByRole("heading", { name: "Heading from data" })).toBeInTheDocument();
    cleanup();
    show(MarkdownWidget, "core/markdown", { a: 1 });
    expect(unexpected()).toHaveTextContent("shows markdown text");
  });
});

describe("core/markdown from a sidecar (linkPolicy external)", () => {
  const sidecarWidget = (value: unknown, options: Record<string, unknown> = {}) =>
    render(
      <Suspense fallback={null}>
        <MarkdownWidget value={value} options={options} freshness={null} widget={{ ...widget("core/markdown", "Notes"), linkPolicy: "external" }} />
      </Suspense>,
    );
  const content = [
    "[evil](//evil.example/)",
    '<a href="http://deck.local/api/health">raw</a>',
    "[health](/api/health)",
    "[frag](#top)",
    "[mail](mailto:x@example.com)",
    "[vendor](https://vendor.example/)",
  ].join(" ");

  it("keeps only absolute http(s) links, each external; every other becomes plain text", () => {
    const { container } = sidecarWidget(null, { content });
    const links = screen.getAllByRole("link");
    expect(links.map((link) => link.getAttribute("href"))).toEqual(["http://deck.local/api/health", "https://vendor.example/"]);
    for (const link of links) {
      expect(link).toHaveAttribute("target", "_blank");
      expect(link).toHaveAttribute("rel", "noopener noreferrer");
      expect(link).toHaveTextContent("(opens in new tab)");
    }
    for (const text of ["evil", "health", "frag", "mail"]) {
      expect(screen.getByText(text).closest("a")?.hasAttribute("href") ?? false, text).toBe(false);
    }
    expect(container.innerHTML).not.toContain("//evil.example");
    expect(container.innerHTML).not.toContain('href="/api/health"');
  });

  it("applies the policy to markdown from its source's data too", () => {
    sidecarWidget("see [the API](/api/config) or [docs](https://docs.example/)");
    expect(screen.getAllByRole("link").map((link) => link.getAttribute("href"))).toEqual(["https://docs.example/"]);
    expect(screen.getByText("the API").closest("a")?.hasAttribute("href") ?? false).toBe(false);
  });

  it("leaves operator markdown (no link policy) as it was", () => {
    show(MarkdownWidget, "core/markdown", null, { content: "[health](/api/health)" });
    expect(screen.getByRole("link", { name: "health" })).toHaveAttribute("href", "/api/health");
  });
});

describe("round 1 fixes", () => {
  it("A: never links a data value a browser would take off deck (http-json-shaped item)", () => {
    // As an http-json provider might serve it: a tab, a line break, a backslash in the path.
    const items = [
      { name: "tab", url: "/\t/evil.example" },
      { name: "newline", url: "/\n/evil.example" },
      { name: "backslash", url: "/\\evil.example" },
      { name: "ok", url: "/hosts" },
    ];
    show(ListWidget, "core/list", items, { hrefField: "url" }, "Links");
    const list = screen.getByRole("list", { name: "Links" });
    expect(within(list).getAllByRole("link").map((link) => link.getAttribute("href"))).toEqual(["/hosts"]);
    cleanup();
    show(LinkTilesWidget, "core/link-tiles", items.map(({ name, url }) => ({ title: name, href: url })), {}, "Tiles");
    expect(within(screen.getByRole("list", { name: "Tiles" })).getAllByRole("link").map((link) => link.textContent)).toEqual(["ok"]);
  });

  it("B: enumerates a dotted key as one key, never as a path", () => {
    show(StatGridWidget, "core/stat-grid", { "load.avg": 42, load: { avg: 99 } });
    expect(screen.getAllByRole("term").map((term) => term.textContent)).toEqual(["load.avg"]);
    expect(screen.getByRole("definition")).toHaveTextContent("42");
    cleanup();
    show(KeyValueWidget, "core/key-value", { "load.avg": 42 });
    expect(screen.getByRole("definition")).toHaveTextContent("42");
  });

  it("D: tones a meter by the value as given, not the number it reads as", () => {
    const { container } = show(MeterWidget, "core/meter", "01", { statusMap: "code" });
    expect(container.querySelector('[data-slot="meter"]')).toHaveAttribute("data-tone", "warn");
    cleanup();
    const other = show(MeterWidget, "core/meter", 1, { statusMap: "code" });
    expect(other.container.querySelector('[data-slot="meter"]')).toHaveAttribute("data-tone", "ok");
  });

  it("F: puts markdown headings (and raw HTML ones) below the card's h3", () => {
    show(MarkdownWidget, "core/markdown", null, { content: "# One\n\n## Two\n\n<h1 id=x>Raw</h1>\n\n#### Four" });
    const levels = screen.getAllByRole("heading").map((heading) => [heading.textContent, heading.tagName]);
    expect(levels).toEqual([["One", "H4"], ["Two", "H5"], ["Raw", "H4"], ["Four", "H6"]]);
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
    expect(screen.getByRole("heading", { name: "Raw" })).toHaveAttribute("id", "x");
  });

  it("N4: demotes before the sanitiser, which still strips what a heading or its neighbours carry", () => {
    const { container } = show(MarkdownWidget, "core/markdown", null, {
      content: '<h1 onclick="alert(1)">Click</h1><h2><img src=x onerror=alert(1)>Img</h2><script>window.pwned=1</script>',
    });
    const heading = screen.getByRole("heading", { name: "Click" });
    expect(heading.tagName).toBe("H4");
    expect(heading).not.toHaveAttribute("onclick");
    expect(screen.getByRole("heading", { name: "Img" }).tagName).toBe("H5");
    expect(container.querySelector("img")?.getAttribute("onerror")).toBeFalsy();
    expect(container.querySelector("script")).toBeNull();
  });

  it("G: caps status tiles at their limit and enumerated fields at the schema's maxima, and says so", () => {
    const states = Array.from({ length: 60 }, (_, index) => ({ name: `s${index}`, status: "running" }));
    show(StatusGridWidget, "core/status-grid", states, {}, "States");
    expect(within(screen.getByRole("list", { name: "States" })).getAllByRole("listitem")).toHaveLength(48);
    expect(screen.getByText("Showing the first 48 of 60 states.")).toBeInTheDocument();
    cleanup();
    show(StatusGridWidget, "core/status-grid", states, { limit: 5 }, "States");
    expect(within(screen.getByRole("list", { name: "States" })).getAllByRole("listitem")).toHaveLength(5);
    cleanup();
    const wide = Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`k${index}`, index]));
    show(StatGridWidget, "core/stat-grid", wide);
    expect(screen.getAllByRole("term")).toHaveLength(24);
    expect(screen.getByText("Showing the first 24 of 30 values.")).toBeInTheDocument();
    cleanup();
    show(KeyValueWidget, "core/key-value", Object.fromEntries(Array.from({ length: 50 }, (_, index) => [`k${index}`, index])));
    expect(screen.getAllByRole("term")).toHaveLength(48);
    expect(screen.getByText("Showing the first 48 of 50 values.")).toBeInTheDocument();
  });

  it("H: says when a table cut rows or left out items that are not objects", () => {
    show(TableWidget, "core/table", [{ name: "a" }, "stray", 3, { name: "b" }, { name: "c" }], { columns: [{ field: "name" }], limit: 2 }, "T");
    expect(within(screen.getByRole("table", { name: "T" })).getAllByRole("rowheader").map((cell) => cell.textContent)).toEqual(["a", "b"]);
    expect(screen.getByText("Showing the first 2 of 3 rows.")).toBeInTheDocument();
    expect(screen.getByText("2 items are not an object, so not a row.")).toBeInTheDocument();
    cleanup();
    show(TableWidget, "core/table", ["x", "y"], { columns: [{ field: "name" }] });
    expect(unexpected()).toHaveTextContent("shows a list of objects");
  });

  it("I: leaves a missing value untoned, even under a catch-all rule", () => {
    const { container } = show(StatGridWidget, "core/stat-grid", { a: 1 }, { items: [{ field: "a", statusMap: "any" }, { field: "gone", statusMap: "any" }] });
    const tiles = [...container.querySelectorAll('[data-slot="stat-tile"]')];
    expect(tiles.map((tile) => tile.getAttribute("data-tone"))).toEqual(["danger", "neutral"]);
    expect(tiles[1]!.querySelector("svg")).toBeNull();
  });

  it("K: reads a meter's value as it is, past the bar too, with its unit, and says it the same way", () => {
    show(MeterWidget, "core/meter", 150, { label: "Over" });
    expect(screen.getByRole("meter", { name: "Over" })).toHaveAttribute("aria-valuetext", "150%");
    expect(screen.getByText("150%")).toBeInTheDocument();
    cleanup();
    show(MeterWidget, "core/meter", 180, { label: "Draw", max: 200, unit: "W" });
    expect(screen.getByText("180 W")).toBeInTheDocument();
    expect(screen.getByRole("meter", { name: "Draw" })).toHaveAttribute("aria-valuetext", "180 W of 200 W");
    cleanup();
    show(MeterWidget, "core/meter", 250, { label: "Pct", max: 500, format: "percent" });
    expect(screen.getByRole("meter", { name: "Pct" })).toHaveAttribute("aria-valuetext", "250%");
    cleanup();
    show(MeterWidget, "core/meter", 50, { label: "Half", max: 200 });
    expect(screen.getByRole("meter", { name: "Half" })).toHaveAttribute("aria-valuetext", "25%");
  });

  it("N1: reads a meter whose percentage overflows as its value of max, visibly and to assistive tech", () => {
    for (const [value, max, text] of [
      [1e308, 1e-308, "1E308 of 1E-308"],
      [-1e308, 1e-308, "-1E308 of 1E-308"],
      [1, 5e-324, "1 of 5E-324"],
    ] as const) {
      show(MeterWidget, "core/meter", value, { label: "Huge", max });
      const meter = screen.getByRole("meter", { name: "Huge" });
      expect(meter).toHaveAttribute("aria-valuetext", text);
      expect(screen.getByText(text)).toBeInTheDocument();
      expect(document.body.textContent).not.toMatch(/∞|NaN/);
      cleanup();
    }
    // A finite but huge ratio stays a short percentage.
    show(MeterWidget, "core/meter", 1e300, { label: "Big" });
    expect(screen.getByRole("meter", { name: "Big" }).getAttribute("aria-valuetext")!.length).toBeLessThanOrEqual(16);
  });

  it("L: renders a field configured twice without a duplicate key", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    show(StatGridWidget, "core/stat-grid", { a: 1 }, { items: [{ field: "a", label: "One" }, { field: "a", label: "Again" }] });
    show(KeyValueWidget, "core/key-value", { a: 1 }, { items: [{ field: "a" }, { field: "a" }] });
    expect(error.mock.calls.flat().join(" ")).not.toMatch(/same key/);
  });
});
