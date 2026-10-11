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
 * Generic widgets on a config page, through the whole shell: tones from the manifest's status
 * maps, a lazily loaded widget waiting in its own card, the top bar's health pills on a page,
 * and the page's label (its nav entry's, when config relabels it) in the top bar and the
 * document title.
 */
// Through a variable: Vite rewrites `new URL("…", import.meta.url)` written inline as an asset.
const TEST_FILE_URL = import.meta.url;
const golden = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../server/test/golden/ui/examples-estate.json", TEST_FILE_URL)), "utf8"),
) as UiManifest;

const FRESH = { state: "fresh", observedAt: "2026-01-01T00:00:00.000Z", ageMs: 1000, ttlMs: 60_000 } as const;
const UPS = { id: "ups", kind: "http-json" };

function widget(id: string, type: string, extra: Partial<UiWidgetInstance> = {}): UiWidgetInstance {
  return { id: `widget:ui/lab.${id}`, type, title: `Widget ${id}`, source: null, options: {}, span: 1, rows: 1, ...extra };
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
        columns: 2,
        widgets: [
          widget("load", "core/stat", { source: UPS, select: "load", projection: "widget:ui/lab.load", options: { format: "percent", statusMap: "ups-load" } }),
          widget("outlets", "core/table", { source: UPS, select: "outlets", projection: "widget:ui/lab.outlets", options: { columns: [{ field: "name" }, { field: "state", statusMap: "outlet" }] } }),
          widget("pills", "core/health-pills"),
        ],
      },
    ],
  },
};

const envelope = (): ProviderEnvelope => ({
  id: "ups",
  kind: "http-json",
  freshness: FRESH,
  data: { load: 91, outlets: [{ name: "nas", state: "on" }, { name: "pi", state: "fault" }] },
  error: null,
  projections: {
    "widget:ui/lab.load": { value: 91 },
    "widget:ui/lab.outlets": { value: [{ name: "nas", state: "on" }, { name: "pi", state: "fault" }] },
  },
});

function served(navLabel = "Lab overview", extra: Partial<UiManifest> = {}): UiManifest {
  return {
    ...golden,
    pages: [...golden.pages, LAB],
    providers: [...golden.providers, UPS],
    nav: [...golden.nav, { id: "nav:ui/lab", module: "ui", slot: "app/nav", page: "page:ui/lab", group: "lab", label: navLabel, order: 0 }],
    navGroups: [...golden.navGroups, { id: "lab", label: "Lab" }],
    statusMaps: {
      "ups-load": { rules: [{ lt: 60, tone: "ok" }, { lt: 85, tone: "warn" }, { tone: "danger" }] },
      outlet: { values: { on: "ok", fault: "danger" } },
    },
    ...extra,
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetQueryClient();
});

async function renderApp(path: string, ui: UiManifest) {
  vi.resetModules();
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url === "/api/config") return Response.json(primary.merged);
    if (url === "/api/ui") return Response.json(ui);
    if (url === "/api/providers/ups") return Response.json(envelope());
    return new Response(null, { status: 404 });
  }));
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
}

const main = () => screen.getByRole("main");

describe("generic widgets on a config page", () => {
  it("tone values by the manifest's status maps", async () => {
    await renderApp("/lab", served());
    const load = await screen.findByRole("region", { name: "Widget load" });
    await waitFor(() => expect(within(load).getByText("91%")).toBeInTheDocument());
    expect(load.querySelector('[data-slot="stat-tile"]')).toHaveAttribute("data-tone", "danger");
  });

  it("load a lazy widget (core/table) inside its own card, the rest of the page already rendered", async () => {
    await renderApp("/lab", served());
    const outlets = await screen.findByRole("region", { name: "Widget outlets" });
    const table = await within(outlets).findByRole("table", { name: "Widget outlets" });
    expect(within(table).getAllByRole("rowheader").map((cell) => cell.textContent)).toEqual(["nas", "pi"]);
    expect(table.querySelector('[data-slot="status-badge"][data-tone="danger"]')).toHaveTextContent("fault");
  });

  it("show the top bar's health pills on the page", async () => {
    await renderApp("/lab", served());
    const pills = await screen.findByRole("region", { name: "Widget pills" });
    const header = screen.getByRole("banner", { name: "Deck" });
    await waitFor(() => expect(header.querySelectorAll('[data-slot="health-pill"]').length).toBeGreaterThan(0));
    const shown = [...pills.querySelectorAll('[data-slot="health-pill"]')].map((pill) => pill.getAttribute("href"));
    expect(shown).toEqual([...header.querySelectorAll('[data-slot="health-pill"]')].map((pill) => pill.getAttribute("href")));
  });
});

describe("a page's label", () => {
  it("is its title in the top bar and the document title, and its heading", async () => {
    await renderApp("/lab", served());
    await screen.findByRole("heading", { level: 1, name: "Lab overview" });
    expect(within(screen.getByRole("banner", { name: "Deck" })).getByText("Lab overview")).toBeInTheDocument();
    await waitFor(() => expect(document.title).toMatch(/^Lab overview · /));
  });

  it("is its nav entry's label wherever the shell names it, when config relabels the entry", async () => {
    await renderApp("/lab", served("UPS"));
    // The heading stays the page's title.
    await screen.findByRole("heading", { level: 1, name: "Lab overview" });
    expect(within(screen.getByRole("navigation", { name: "Primary" })).getByRole("link", { name: "UPS" })).toHaveAttribute("href", "/lab");
    expect(within(screen.getByRole("banner", { name: "Deck" })).getByText("UPS")).toBeInTheDocument();
    await waitFor(() => expect(document.title).toMatch(/^UPS · /));
    expect(within(main()).queryByText("UPS")).toBeNull();
  });

  it("is a module page's manifest title, and its home label at /", async () => {
    const hosts = golden.pages.find((page) => page.id === "page:inventory/hosts")!;
    const relabelled = served("Lab overview", {
      pages: [...golden.pages.filter((page) => page !== hosts), { ...hosts, title: "Machines" }, LAB],
      nav: golden.nav.map((item) => (item.page === hosts.id ? { ...item, label: "Machines" } : item)),
      home: { page: "page:ui/lab", path: "/lab" },
    });
    await renderApp("/hosts", relabelled);
    await waitFor(() => expect(document.title).toMatch(/^Machines · /));
    cleanup();
    resetQueryClient();
    await renderApp("/", relabelled);
    await screen.findByRole("heading", { level: 1, name: "Lab overview" });
    await waitFor(() => expect(document.title).toMatch(/^Lab overview · /));
  });
});
