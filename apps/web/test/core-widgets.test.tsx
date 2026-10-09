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
