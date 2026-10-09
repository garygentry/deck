// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { ProviderEnvelope } from "@deck/contract";
import type { UiManifest, UiPage, UiWidgetInstance } from "@deck/module-sdk";
import { primary } from "@deck/schema/fixtures";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { resetQueryClient } from "../src/data/query-client.js";

/**
 * Config pages (`ui.pages`): the layout (one h1, a heading per section, widgets in config
 * order on a grid that is one column below md), each widget's states from its provider's
 * envelope, the widget type registry, and the route the shell gives each page.
 */
const TEST_FILE_URL = import.meta.url;
const golden = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../server/test/golden/ui/examples-estate.json", TEST_FILE_URL)), "utf8"),
) as UiManifest;

const FRESH = { state: "fresh", observedAt: "2026-01-01T00:00:00.000Z", ageMs: 1000, ttlMs: 60_000 } as const;

function widget(id: string, extra: Partial<UiWidgetInstance> = {}): UiWidgetInstance {
  return { id: `widget:ui/lab.${id}`, type: "core/json", title: `Widget ${id}`, source: null, options: {}, span: 1, rows: 1, ...extra };
}

const LAB: UiPage = {
  id: "page:ui/lab",
  module: "ui",
  path: "/lab",
  title: "Lab overview",
  component: "ConfigPage",
  layout: {
    sections: [
      {
        title: "Power",
        columns: 3,
        widgets: [
          widget("load", { source: { id: "ups", kind: "http-json" }, select: "load", projection: "widget:ui/lab.load", span: 2 }),
          widget("raw", { source: { id: "ups", kind: "http-json" }, rows: 2 }),
          widget("wide", { span: 3 }),
        ],
      },
      { title: "Notes", columns: 1, widgets: [widget("note")] },
    ],
  },
};

function envelope(extra: Partial<ProviderEnvelope> = {}): ProviderEnvelope {
  return {
    id: "ups",
    kind: "http-json",
    freshness: FRESH,
    data: { load: 41, outlets: [] },
    error: null,
    projections: { "widget:ui/lab.load": { value: 41 } },
    ...extra,
  };
}

function served(extra: Partial<UiManifest> = {}): UiManifest {
  return {
    ...golden,
    pages: [...golden.pages, LAB],
    providers: [...golden.providers, { id: "ups", kind: "http-json" }],
    nav: [...golden.nav, { id: "nav:ui/lab", module: "ui", slot: "app/nav", page: "page:ui/lab", group: "lab", label: "Lab overview", order: 0 }],
    navGroups: [...golden.navGroups, { id: "lab", label: "lab" }],
    ...extra,
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetQueryClient();
});

/** Render the whole app at `path`, serving `ui` and the `ups` provider's envelope. */
async function renderApp(
  path: string,
  ui: UiManifest | (() => Promise<UiManifest>),
  ups: () => ProviderEnvelope | null = () => envelope(),
) {
  vi.resetModules();
  const fetch = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url === "/api/config") return Response.json(primary.merged);
    if (url === "/api/ui") return Response.json(typeof ui === "function" ? await ui() : ui);
    if (url === "/api/providers/ups") {
      const body = ups();
      return body === null ? new Response(null, { status: 404 }) : Response.json(body);
    }
    return new Response(null, { status: 404 });
  });
  vi.stubGlobal("fetch", fetch);
  vi.stubGlobal("location", new URL(`http://localhost${path}`));
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false, media: query, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  }));
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  await import("../src/shell/health-header/slot.js");
  await import("../src/registry/discover.js");
  const { App } = await import("../src/shell/App.js");
  render(<App />);
  return fetch;
}

const main = () => screen.getByRole("main");

describe("a config page", () => {
  it("routes at its path and lists in the nav", async () => {
    await renderApp("/lab", served());
    expect(await screen.findByRole("heading", { level: 1, name: "Lab overview" })).toBeInTheDocument();
    const nav = screen.getByRole("navigation", { name: "Primary" });
    expect(within(nav).getByRole("link", { name: "Lab overview" })).toHaveAttribute("href", "/lab");
  });

  it("has one h1, a heading per section and per widget, in config (DOM) order", async () => {
    await renderApp("/lab", served());
    await screen.findByRole("heading", { level: 1, name: "Lab overview" });
    expect(within(main()).getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(within(main()).getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent)).toEqual(["Power", "Notes"]);
    expect(within(main()).getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent)).toEqual([
      "Widget load",
      "Widget raw",
      "Widget wide",
      "Widget note",
    ]);
    // Every section and widget is a region named by its heading.
    expect(within(main()).getByRole("region", { name: "Power" })).toBeInTheDocument();
    expect(within(main()).getByRole("region", { name: "Widget load" })).toBeInTheDocument();
  });

  it("lays sections out as one column below md and its columns from md, with spans and rows from md", async () => {
    await renderApp("/lab", served());
    await screen.findByRole("heading", { level: 1, name: "Lab overview" });
    const grids = [...document.querySelectorAll('[data-slot="widget-grid"]')];
    expect(grids.map((grid) => grid.className)).toEqual([
      expect.stringMatching(/(^| )grid-cols-1 .*md:grid-cols-3/),
      expect.stringMatching(/(^| )grid-cols-1 .*md:grid-cols-1/),
    ]);
    const widgets = [...document.querySelectorAll('[data-slot="widget"]')];
    expect(widgets.map((node) => node.getAttribute("data-widget-id"))).toEqual(["widget:ui/lab.load", "widget:ui/lab.raw", "widget:ui/lab.wide", "widget:ui/lab.note"]);
    expect(widgets[0]!.className).toContain("md:col-span-2");
    expect(widgets[1]!.className).toContain("md:row-span-2");
    expect(widgets[2]!.className).toContain("md:col-span-3");
    // No class spans a column below md, and the grid never reorders (no dense packing).
    for (const node of [...grids, ...widgets]) expect(node.className).not.toMatch(/(^| )(col-span|row-span)-|dense|order-/);
  });

  it("renders a widget's select result, and a source without a select its data whole", async () => {
    await renderApp("/lab", served());
    const load = await screen.findByRole("region", { name: "Widget load" });
    await waitFor(() => expect(within(load).getByText("41")).toBeInTheDocument());
    const raw = within(main()).getByRole("region", { name: "Widget raw" });
    expect(raw.textContent).toContain('"outlets": []');
  });

  it("is not found when the manifest no longer routes it", async () => {
    await renderApp("/lab", golden);
    expect(await screen.findByText("Page not found")).toBeInTheDocument();
  });

  it("is not routed from a malformed layout", async () => {
    await renderApp("/lab", served({ pages: [...golden.pages, { ...LAB, layout: { sections: [null] } } as unknown as UiPage] }));
    expect(await screen.findByText("Page not found")).toBeInTheDocument();
  });
});

/** A remote integration's page, as the server lists it: module `remote`, rendered as a config page. */
const UPS: UiPage = {
  id: "page:remote/ups",
  module: "remote",
  path: "/remote/ups",
  title: "UPS",
  component: "ConfigPage",
  layout: {
    sections: [
      {
        title: "UPS",
        columns: 2,
        widgets: [
          { ...widget("load"), id: "widget:remote/ups.load", title: "Load", source: { id: "ups", kind: "remote" }, select: "load", projection: "widget:remote/ups.load" },
          {
            ...widget("links"),
            id: "widget:remote/ups.links",
            type: "core/link-tiles",
            title: "Links",
            span: 2,
            options: { links: [{ title: "Looks internal", href: "http://localhost/portal", icon: "no-such-icon" }, { title: "Portal", href: "/portal" }] },
          },
        ],
      },
    ],
  },
};

function servedRemote(): UiManifest {
  return {
    ...golden,
    pages: [...golden.pages, UPS],
    providers: [...golden.providers, { id: "ups", kind: "remote" }],
    nav: [
      ...golden.nav,
      { id: "nav:remote/ups", module: "remote", slot: "app/nav", page: "page:remote/ups", group: "lab", label: "UPS", order: 0 },
      { id: "nav:remote/ups.nut", module: "remote", slot: "app/nav", href: "http://localhost/nut", group: "lab", label: "NUT web UI", icon: "no-such-icon", order: 1 },
    ],
    navGroups: [...golden.navGroups, { id: "lab", label: "lab" }],
  };
}

describe("a remote integration's page", () => {
  it("routes like a config page, its widgets reading the integration's projections", async () => {
    await renderApp("/remote/ups", servedRemote(), () => ({ ...envelope(), kind: "remote", projections: { "widget:remote/ups.load": { value: 23 } } }));
    expect(await screen.findByRole("heading", { level: 1, name: "UPS" })).toBeInTheDocument();
    const load = within(main()).getByRole("region", { name: "Load" });
    await waitFor(() => expect(within(load).getByText("23")).toBeInTheDocument());
    const nav = screen.getByRole("navigation", { name: "Primary" });
    expect(within(nav).getByRole("link", { name: "UPS" })).toHaveAttribute("href", "/remote/ups");
  });

  it("shows a sidecar's http(s) links as external, even one that looks same-origin; a path stays in deck", async () => {
    await renderApp("/remote/ups", servedRemote());
    await screen.findByRole("heading", { level: 1, name: "UPS" });
    const nav = screen.getByRole("navigation", { name: "Primary" });
    const sidecarNav = within(nav).getByRole("link", { name: /NUT web UI/ });
    expect(sidecarNav).toHaveAttribute("href", "http://localhost/nut");
    expect(sidecarNav).toHaveAttribute("target", "_blank");
    const tiles = within(main()).getByRole("region", { name: "Links" });
    expect(within(tiles).getByRole("link", { name: /Looks internal/ })).toHaveAttribute("target", "_blank");
    expect(within(tiles).getByRole("link", { name: /Portal/ })).not.toHaveAttribute("target");
  });

  it("is not routed as a config page when another module lists it", async () => {
    await renderApp("/remote/ups", { ...servedRemote(), pages: [...golden.pages, { ...UPS, module: "portal" }] });
    expect(await screen.findByText("Page not found")).toBeInTheDocument();
  });
});

describe("widgetView", async () => {
  const { widgetView, isEmptyValue } = await import("../src/shell/config-page/WidgetHost.js");
  const type = { type: "core/json", module: "core", component: () => null };
  const sourced = widget("load", { source: { id: "ups", kind: "http-json" }, select: "load", projection: "widget:ui/lab.load" });

  it("is an error for a type no module registers, or a source that did not resolve", () => {
    expect(widgetView(sourced, undefined, null)).toMatchObject({ state: "error", title: "Widget unavailable" });
    // The server says no enabled module provides it, or the manifest does not list it: unavailable,
    // even though the web bundles a component for it.
    expect(widgetView(widget("x", { typeProblem: 'No enabled module provides the widget type "gauges/dial".' }), type, null)).toEqual({
      state: "error",
      title: "Widget unavailable",
      message: 'No enabled module provides the widget type "gauges/dial".',
    });
    expect(widgetView(sourced, type, { envelope: envelope(), loading: false }, false)).toMatchObject({ state: "error", title: "Widget unavailable" });
    expect(widgetView(widget("x", { sourceProblem: 'It reads provider "nope", which is not configured.' }), type, null)).toEqual({
      state: "error",
      title: "No data source",
      message: 'It reads provider "nope", which is not configured.',
    });
  });

  it("is loading until the first read, and while the provider is pending", () => {
    expect(widgetView(sourced, type, { envelope: null, loading: true })).toEqual({ state: "loading" });
    const pending = envelope({ data: null, projections: {}, freshness: { state: "pending", observedAt: null, ageMs: null, ttlMs: 60_000 } });
    expect(widgetView(sourced, type, { envelope: pending, loading: false })).toEqual({ state: "loading" });
  });

  it("is an error when the provider cannot be read or has failed without data, with its message as detail", () => {
    expect(widgetView(sourced, type, { envelope: null, loading: false })).toMatchObject({ state: "error", title: "Data source unavailable" });
    const failed = envelope({ data: null, projections: {}, error: { message: "Provider poll timed out after 5000ms" }, freshness: { ...FRESH, state: "unreachable" } });
    expect(widgetView(sourced, type, { envelope: failed, loading: false })).toMatchObject({ state: "error", details: "Provider poll timed out after 5000ms" });
  });

  it("is an error when the select failed on the data, or the server sent no result", () => {
    const failed = envelope({ projections: { "widget:ui/lab.load": { error: "abs() takes 1 argument" } } });
    expect(widgetView(sourced, type, { envelope: failed, loading: false })).toMatchObject({ state: "error", title: "Select failed", details: "abs() takes 1 argument" });
    expect(widgetView(sourced, type, { envelope: envelope({ projections: undefined }), loading: false })).toMatchObject({ state: "error", title: "No result" });
  });

  it("is empty for a null, empty-list or empty-object value, keeping the freshness", () => {
    for (const value of [null, [], {}]) {
      const empty = envelope({ projections: { "widget:ui/lab.load": { value } } });
      expect(widgetView(sourced, type, { envelope: empty, loading: false })).toEqual({ state: "empty", freshness: FRESH });
    }
    expect([0, false, "", [0], { a: null }].map(isEmptyValue)).toEqual([false, false, false, false, false]);
  });

  it("is ready with the projection's value, or the data whole without a select", () => {
    expect(widgetView(sourced, type, { envelope: envelope(), loading: false })).toEqual({ state: "ready", value: 41, freshness: FRESH });
    expect(widgetView(widget("raw", { source: { id: "ups", kind: "http-json" } }), type, { envelope: envelope(), loading: false })).toEqual({
      state: "ready",
      value: { load: 41, outlets: [] },
      freshness: FRESH,
    });
  });
});

describe("a widget on the page", () => {
  it("shows the stale state from the envelope's freshness", async () => {
    await renderApp("/lab", served(), () => envelope({ freshness: { ...FRESH, state: "stale", ageMs: 600_000 } }));
    const load = await screen.findByRole("region", { name: "Widget load" });
    await waitFor(() => expect(within(load).getByText("41")).toBeInTheDocument());
    expect(load.querySelector('[data-slot="freshness-badge"]')).toHaveAttribute("data-freshness", "stale");
    // A fresh source shows no badge.
  });

  it("shows no badge while fresh, and the empty and error states", async () => {
    await renderApp("/lab", served(), () => envelope({ projections: { "widget:ui/lab.load": { error: "boom" } }, data: { load: 1, outlets: [] } }));
    const load = await screen.findByRole("region", { name: "Widget load" });
    await waitFor(() => expect(within(load).getByText("Select failed")).toBeInTheDocument());
    expect(load.querySelector('[data-slot="freshness-badge"]')).toBeNull();
    // A widget without a source renders its type with a null value (static widgets have none).
    const note = within(main()).getByRole("region", { name: "Widget note" });
    expect(note.querySelector("code")?.textContent).toBe("null");
    // An empty select result is the empty state.
    cleanup();
    await renderApp("/lab", served(), () => envelope({ projections: { "widget:ui/lab.load": { value: [] } } }));
    const empty = await screen.findByRole("region", { name: "Widget load" });
    await waitFor(() => expect(within(empty).getByText("No data to show")).toBeInTheDocument());
  });

  it("isolates a widget that throws: the page and its other widgets keep working", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const throwing = { ...LAB, layout: { sections: [{ title: "S", columns: 2 as const, widgets: [widget("boom", { type: "test/boom" }), widget("fine")] }] } };
    vi.resetModules();
    const registry = await import("../src/registry/registry.js");
    registry.registerWidgetType({
      type: "test/boom",
      module: "test",
      component: () => {
        throw new Error("render failure");
      },
    });
    const { WidgetHost } = await import("../src/shell/config-page/WidgetHost.js");
    await import("../src/features/core-widgets/index.js");
    render(
      <>
        {throwing.layout.sections[0]!.widgets.map((instance) => (
          <WidgetHost key={instance.id} widget={instance} />
        ))}
      </>,
    );
    const boom = screen.getByRole("region", { name: "Widget boom" });
    expect(within(boom).getByRole("alert")).toHaveTextContent("Widget boom unavailable");
    expect(screen.getByRole("region", { name: "Widget fine" }).querySelector("code")?.textContent).toBe("null");
  });
});

describe("a widget whose type the manifest does not list", () => {
  it("renders as unavailable and reads no data, though the web bundles its component", async () => {
    const fetch = await renderApp("/lab", served({ widgetTypes: [] }));
    const load = await screen.findByRole("region", { name: "Widget load" });
    expect(within(load).getByText("Widget unavailable")).toBeInTheDocument();
    expect(within(main()).getAllByText("Widget unavailable")).toHaveLength(4);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fetch.mock.calls.map(([input]) => String(input))).not.toContain("/api/providers/ups");
  });
});

describe("while the manifest loads", () => {
  it("a deep link to a config page shows a loading state, never 'not found', then the page", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    await renderApp("/lab", async () => {
      await gate;
      return served();
    });
    expect(await screen.findByText("Loading page…")).toBeInTheDocument();
    expect(screen.queryByText("Page not found")).toBeNull();
    release();
    expect(await screen.findByRole("heading", { level: 1, name: "Lab overview" })).toBeInTheDocument();
  });

  it("a config page as home shows a loading state at /, never the portal", async () => {
    const boot = document.createElement("script");
    boot.type = "application/json";
    boot.id = (await import("@deck/contract")).BOOT_ELEMENT_ID;
    boot.textContent = JSON.stringify({ bootApi: 1, brand: { title: "Lab" }, theme: {}, home: "page:ui/lab" });
    document.head.append(boot);
    try {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      await renderApp("/", async () => {
        await gate;
        return served({ home: { page: "page:ui/lab", path: "/lab" } });
      });
      expect(await screen.findByText("Loading page…")).toBeInTheDocument();
      expect(screen.queryByRole("heading", { level: 1, name: "Portal" })).toBeNull();
      release();
      expect(await screen.findByRole("heading", { level: 1, name: "Lab overview" })).toBeInTheDocument();
    } finally {
      boot.remove();
    }
  });

  it("awaits only while loading, for / with a config home and for unrouted paths", async () => {
    const { awaitingConfigPage } = await import("../src/shell/App.js");
    const routes = { home: undefined, routed: [{ id: "page:portal/overview" as const, path: "/portal", label: "Portal", component: () => null }], notEnabled: [] };
    const loading = { status: "loading" } as const;
    expect(awaitingConfigPage(loading, routes, "/", "page:ui/lab")).toBe(true);
    expect(awaitingConfigPage(loading, routes, "/", "page:remote/ups")).toBe(true);
    expect(awaitingConfigPage(loading, routes, "/", "page:portal/overview")).toBe(false);
    expect(awaitingConfigPage(loading, routes, "/", undefined)).toBe(false);
    expect(awaitingConfigPage(loading, routes, "/lab", undefined)).toBe(true);
    expect(awaitingConfigPage(loading, routes, "/portal", undefined)).toBe(false);
    expect(awaitingConfigPage({ status: "error", message: "down" }, routes, "/lab", "page:ui/lab")).toBe(false);
    expect(awaitingConfigPage({ status: "ready", manifest: golden }, routes, "/lab", "page:ui/lab")).toBe(false);
  });
});

describe("the widget type registry", () => {
  it("registers a module's widget types with their components, refusing another module's namespace", async () => {
    vi.resetModules();
    const { defineWebModule } = await import("@deck/module-sdk");
    const { registerWebModule } = await import("../src/registry/web-module.js");
    const registry = await import("../src/registry/registry.js");
    const Dial = () => null;
    const manifest = { id: "gauges", version: "1", deckApi: "^0.1", contributes: { widgetTypes: [{ type: "gauges/dial" as const, optionsSchema: {}, component: "Dial" }, { type: "gauges/plain" as const, optionsSchema: {} }] } };
    registerWebModule(defineWebModule(manifest, { components: { Dial } }));
    expect(registry.getWidgetType("gauges/dial")).toEqual({ type: "gauges/dial", module: "gauges", component: Dial });
    // A type without a component is left to a later renderer.
    expect(registry.hasWidgetType("gauges/plain")).toBe(false);
    const foreign = { ...manifest, id: "meters", contributes: { widgetTypes: [{ type: "gauges/other" as const, optionsSchema: {}, component: "Dial" }] } };
    expect(() => registerWebModule(defineWebModule(foreign, { components: { Dial } }))).toThrow(/meters\/<name>/);
    expect(() => registerWebModule(defineWebModule(manifest, { components: { Dial } }))).toThrow(/already registered/);
    expect(() => registry.registerWidgetType({ type: "gauges/x", module: "gauges", component: "Dial" as never })).toThrow(/component/);
  });

  it("holds the kernel's core/json once the built-ins are discovered", async () => {
    vi.resetModules();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 404 })));
    await import("../src/registry/discover.js");
    const registry = await import("../src/registry/registry.js");
    expect(registry.getWidgetType("core/json")?.module).toBe("core");
  });
});
