// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { UiManifest } from "@deck/module-sdk";
import { POLL_DEFAULTS } from "@deck/contract";
import { primary } from "@deck/schema/fixtures";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { uiManifestProblem, type UiManifestState } from "../src/data/index.js";
import { resetQueryClient } from "../src/data/query-client.js";
import type { Extension, PageRegistration } from "../src/registry/registry.js";
import { brandInitial, brandTitle, placeExtensions } from "../src/shell/manifest-slot.js";
import { groupNavPages, resolveNav } from "../src/shell/nav.js";

/**
 * The shell renders from the UI manifest: the brand, the nav (groups, order, labels, icons)
 * and the top bar's status and actions slots. The server golden for the example estate (the
 * default env: actions and metrics off) is the manifest the real server serves.
 */
// Vite rewrites the literal `new URL("…", import.meta.url)` form under the jsdom transform;
// resolving against a plain const avoids that.
const TEST_FILE_URL = import.meta.url;
const golden = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../server/test/golden/ui/examples-estate.json", TEST_FILE_URL)), "utf8"),
) as UiManifest;

const ready = (manifest: UiManifest): UiManifestState => ({ status: "ready", manifest });
const LOADING: UiManifestState = { status: "loading" };
const FAILED: UiManifestState = { status: "error", message: "down" };
const Component = () => null;

function page(id: string, path: string, label: string, extra: Partial<PageRegistration> = {}): PageRegistration {
  return { id: id as PageRegistration["id"], path, label, component: Component, ...extra };
}

function extension(id: string, slot: string, order: number, extra: Partial<Extension> = {}): Extension {
  return { id: id as Extension["id"], kind: "pill", module: id.split(":")[1]!.split("/")[0]!, attachTo: { slot, order }, enabled: true, config: {}, component: Component, ...extra };
}

function manifest(parts: Partial<UiManifest>): UiManifest {
  return { uiApi: 1, brand: { title: "Lab" }, modules: [], slots: [], pages: [], disabledPages: [], navGroups: [], nav: [], extensions: [], providers: [], findings: [], ...parts };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetQueryClient();
});

describe("resolveNav", () => {
  const pages = [
    page("page:a/one", "/one", "One (web)", { group: "Web group" }),
    page("page:b/two", "/two", "Two (web)", { group: "Other" }),
    page("page:c/hidden", "/hidden", "Hidden", { nav: false }),
    page("page:d/loose", "/loose", "Loose"),
  ];
  const served = manifest({
    navGroups: [{ id: "second", label: "Second" }, { id: "first", label: "First", icon: "flask-conical" }, { id: "empty", label: "Empty" }],
    nav: [
      { id: "nav:b/two", module: "b", slot: "app/nav", page: "page:b/two", group: "second", label: "Two", icon: "boxes", order: 1 },
      { id: "nav:a/one", module: "a", slot: "app/nav", page: "page:a/one", group: "first", label: "One", order: 1 },
      { id: "nav:x/link", module: "x", slot: "app/nav", href: "https://grafana.lab", group: "first", label: "Grafana", icon: "chart-line", order: 2 },
      // A page the web does not route, and an entry re-attached to another slot: neither is listed.
      { id: "nav:z/gone", module: "z", slot: "app/nav", page: "page:z/gone", group: "second", label: "Gone", order: 3 },
      { id: "nav:y/side", module: "y", slot: "y/side", href: "/side", group: "empty", label: "Side", order: 1 },
    ],
  });

  it("takes groups, their order and labels, and each entry's label and icon from the manifest", () => {
    expect(resolveNav(ready(served), pages)).toEqual([
      { id: "second", label: "Second", links: [{ id: "nav:b/two", label: "Two", icon: "boxes", href: "/two" }] },
      {
        id: "first",
        label: "First",
        links: [
          { id: "nav:a/one", label: "One", icon: undefined, href: "/one" },
          { id: "nav:x/link", label: "Grafana", icon: "chart-line", href: "https://grafana.lab" },
        ],
      },
    ]);
  });

  it("labels an entry without a label by its routed page's label, else its id (version skew)", () => {
    const unlabelled = manifest({
      navGroups: [{ id: "g", label: "G" }],
      nav: [
        { id: "nav:a/one", module: "a", slot: "app/nav", page: "page:a/one", group: "g", order: 1 },
        { id: "nav:x/link", module: "x", slot: "app/nav", href: "/x", group: "g", order: 2 },
      ] as unknown as UiManifest["nav"],
    });
    expect(resolveNav(ready(unlabelled), pages)[0]!.links.map((link) => link.label)).toEqual(["One (web)", "nav:x/link"]);
  });

  it("lists nothing until the manifest loads", () => {
    expect(resolveNav(LOADING, pages)).toEqual([]);
  });

  it("falls back to the registered pages when the manifest cannot be read", () => {
    expect(resolveNav(FAILED, pages)).toEqual(groupNavPages(pages));
    // Groups the fallback does not know follow the built-in ones, alphabetically.
    expect(groupNavPages(pages)).toEqual([
      { id: "Other", label: "Other", links: [{ id: "page:b/two", label: "Two (web)", icon: undefined, href: "/two" }] },
      { id: "Web group", label: "Web group", links: [{ id: "page:a/one", label: "One (web)", icon: undefined, href: "/one" }] },
      { id: undefined, label: undefined, links: [{ id: "page:d/loose", label: "Loose", icon: undefined, href: "/loose" }] },
    ]);
  });

  it("heads groups by id for a manifest without navGroups", () => {
    const old = { ...served, navGroups: undefined } as unknown as UiManifest;
    expect(resolveNav(ready(old), pages).map(({ id, label }) => `${id}:${label}`)).toEqual(["second:second", "first:first"]);
  });
});

describe("placeExtensions", () => {
  const registered = [
    extension("pill:a/first", "app/topbar.status", 10),
    extension("pill:b/second", "app/topbar.status", 20),
    extension("pill:c/off", "app/topbar.status", 5, { enabled: false }),
    extension("action:core/theme-menu", "app/topbar.actions", 100, { kind: "action" }),
  ];

  it("renders the manifest's entries for the slot, in its order, with its order", () => {
    const served = manifest({
      extensions: [
        { id: "pill:b/second", kind: "pill", module: "b", slot: "app/topbar.status", order: 1 },
        { id: "pill:a/first", kind: "pill", module: "a", slot: "app/topbar.status", order: 2 },
        // Unbundled on the web, or of another kind than the web's: skipped.
        { id: "pill:z/remote", kind: "pill", module: "z", slot: "app/topbar.status", order: 3 },
        { id: "action:core/theme-menu", kind: "pill", module: "core", slot: "app/topbar.status", order: 4 },
      ],
    });
    const placed = placeExtensions("app/topbar.status", ready(served), registered);
    expect(placed.map((e) => `${e.attachTo.order} ${e.id}`)).toEqual(["1 pill:b/second", "2 pill:a/first"]);
    // The actions slot has no manifest entry, so nothing renders there.
    expect(placeExtensions("app/topbar.actions", ready(served), registered)).toEqual([]);
  });

  it("never renders an extension the web registered as off, on either path", () => {
    const served = manifest({ extensions: [{ id: "pill:c/off", kind: "pill", module: "c", slot: "app/topbar.status", order: 1 }] });
    expect(placeExtensions("app/topbar.status", ready(served), registered)).toEqual([]);
    expect(placeExtensions("app/topbar.status", FAILED, registered).map((e) => e.id)).not.toContain("pill:c/off");
  });

  it("follows a re-attachment: the extension renders in the manifest's slot", () => {
    const served = manifest({ extensions: [{ id: "pill:a/first", kind: "pill", module: "a", slot: "core/elsewhere", order: 1 }] });
    expect(placeExtensions("core/elsewhere", ready(served), registered).map((e) => e.id)).toEqual(["pill:a/first"]);
    expect(placeExtensions("app/topbar.status", ready(served), registered)).toEqual([]);
  });

  it("is empty while loading, and the registered extensions when the manifest cannot be read", () => {
    expect(placeExtensions("app/topbar.status", LOADING, registered)).toEqual([]);
    expect(placeExtensions("app/topbar.status", FAILED, registered).map((e) => e.id)).toEqual(["pill:a/first", "pill:b/second"]);
  });
});

describe("brandTitle", () => {
  it("is the manifest's brand, deck's when it cannot be read or has none, and none while loading", () => {
    expect(brandTitle(ready(manifest({ brand: { title: "Gentry Lab" } })))).toBe("Gentry Lab");
    expect(brandTitle(ready(manifest({ brand: { title: " " } })))).toBe("Deck");
    expect(brandTitle(ready({ ...manifest({}), brand: undefined } as unknown as UiManifest))).toBe("Deck");
    expect(brandTitle(FAILED)).toBe("Deck");
    expect(brandTitle(LOADING)).toBeUndefined();
  });
});

describe("brandInitial", () => {
  it("is the first whole character, upper-cased", () => {
    expect(brandInitial("example-estate")).toBe("E");
    expect(brandInitial("🚀 Lab")).toBe("🚀");
    expect(brandInitial("  lab")).toBe("L");
    expect(brandInitial(undefined)).toBe("");
  });
});

describe("uiManifestProblem", () => {
  it("accepts the served manifest and a document without the newer shell fields", () => {
    expect(uiManifestProblem(golden)).toBeNull();
    expect(uiManifestProblem({ ...golden, brand: undefined, navGroups: undefined })).toBeNull();
  });

  it.each([
    ["nav: [null]", { nav: [null] }, "nav[0] is malformed"],
    ["extensions: [null]", { extensions: [null] }, "extensions[0] is malformed"],
    ["navGroups: [null]", { navGroups: [null] }, "navGroups[0] is malformed"],
    ["a nav entry with a non-string label", { nav: [{ ...golden.nav[0], label: 3 }] }, "nav[0] is malformed"],
    ["a group without a label", { navGroups: [{ id: "g" }] }, "navGroups[0] is malformed"],
    ["an extension without an order", { extensions: [{ id: "pill:a/b", kind: "pill", slot: "s" }] }, "extensions[0] is malformed"],
    ["nav that is not a list", { nav: {} }, "nav is not a list"],
    ["a brand without a title", { brand: {} }, "brand is malformed"],
    ["a module without enabled", { modules: [{ id: "a" }] }, "modules[0] is malformed"],
    ["a disabled page without a path", { disabledPages: [{ id: "page:a/b", module: "a", title: "B" }] }, "disabledPages[0] is malformed"],
  ])("rejects %s", (_label, patch, problem) => {
    expect(uiManifestProblem({ ...golden, ...patch })).toBe(problem);
  });

  it("never rejects a manifest for a malformed module switch (it is only a hint)", () => {
    for (const enabledBy of [{ env: "A", config: "modules.a" }, "A", [{}], [{ env: 1 }], null]) {
      expect(uiManifestProblem({ ...golden, modules: [{ id: "a", version: "1", enabled: false, origin: "module", enabledBy }] })).toBeNull();
    }
  });
});

describe("the shell, rendered from the served manifest", () => {
  async function renderApp(ui: (() => Response) | undefined, path = "/") {
    vi.resetModules();
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === "/api/config") return Response.json(primary.merged);
      if (url === "/api/ui" && ui !== undefined) return ui();
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
    return screen.getByRole("navigation", { name: "Primary" });
  }

  const links = (nav: HTMLElement) => within(nav).queryAllByRole("link").map((link) => `${link.textContent} ${link.getAttribute("href")}`);

  it("lists the manifest's groups and entries, in its order; a disabled module's page is not listed", async () => {
    const nav = await renderApp(() => Response.json(golden));
    await waitFor(() => expect(links(nav).length).toBeGreaterThan(0));
    expect(links(nav)).toEqual([
      "Portal /",
      "Hosts /hosts",
      "Services /services",
      "Drift /drift",
      "LLM usage /usage",
      "Monitoring /monitoring",
      "Configs /configs",
      "Docs /docs",
    ]);
    // Actions is off in this env, so its group and page are not listed (the web still bundles it).
    for (const label of ["Overview", "Inventory", "Health", "Knowledge"]) expect(within(nav).getByText(label)).toBeInTheDocument();
    expect(within(nav).queryByText("Operate")).not.toBeInTheDocument();
  });

  it("follows the manifest's labels, icons and group order rather than the web's registrations", async () => {
    const relabelled: UiManifest = {
      ...golden,
      navGroups: [{ id: "knowledge", label: "Library" }, ...golden.navGroups.filter((group) => group.id !== "knowledge")],
      nav: golden.nav.map((item) => (item.id === "nav:sources/docs" ? { ...item, label: "Runbooks" } : item)),
    };
    const nav = await renderApp(() => Response.json(relabelled));
    await waitFor(() => expect(links(nav).length).toBeGreaterThan(0));
    expect(links(nav).slice(0, 3)).toEqual(["Configs /configs", "Runbooks /docs", "Portal /"]);
    expect(within(nav).getByText("Library")).toBeInTheDocument();
  });

  it("brands the sidebar and the document title with the estate's name", async () => {
    await renderApp(() => Response.json(golden));
    const home = await screen.findByRole("link", { name: "example-estate" });
    expect(home).toHaveAttribute("href", "/");
    await waitFor(() => expect(document.title).toBe("Portal · example-estate"));
  });

  it("renders the top bar's actions slot from the manifest: the theme menu, unless the manifest drops it", async () => {
    await renderApp(() => Response.json(golden));
    expect(await screen.findByRole("button", { name: /^Theme: / })).toBeInTheDocument();

    cleanup();
    resetQueryClient();
    const without = { ...golden, extensions: golden.extensions.filter((entry) => entry.id !== "action:core/theme-menu") };
    const nav = await renderApp(() => Response.json(without));
    await waitFor(() => expect(links(nav).length).toBeGreaterThan(0));
    expect(screen.queryByRole("button", { name: /^Theme: / })).not.toBeInTheDocument();
  });

  it("renders the status slot's pills in the manifest's order", async () => {
    const statusIds = golden.extensions.filter((entry) => entry.slot === "app/topbar.status").map((entry) => entry.id);
    // Reverse the order and drop one: the header follows.
    const reordered = {
      ...golden,
      extensions: [
        ...golden.extensions.filter((entry) => entry.slot !== "app/topbar.status"),
        ...statusIds.slice(1).reverse().map((id, order) => ({ ...golden.extensions.find((entry) => entry.id === id)!, order })),
      ],
    };
    vi.resetModules();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 404 })));
    const registry = await import("../src/registry/registry.js");
    const { HealthHeaderSlot } = await import("../src/shell/health-header/slot.js");
    for (const id of statusIds) {
      registry.registerSummaryFragment(HealthHeaderSlot, { id: id as Extension["id"], component: () => <span data-testid="pill">{id}</span> });
    }
    const { getQueryClient } = await import("../src/data/query-client.js");
    getQueryClient().setQueryData(["ui"], reordered);
    const { HealthHeaderRegion } = await import("../src/shell/health-header/HealthHeaderRegion.js");
    render(<HealthHeaderRegion />);
    expect(screen.getAllByTestId("pill").map((pill) => pill.textContent)).toEqual(statusIds.slice(1).reverse());
  });

  it("stays navigable when the manifest cannot be read: the registered pages, deck's brand, the theme menu", async () => {
    const nav = await renderApp(() => new Response(null, { status: 500 }));
    await waitFor(() => expect(links(nav).length).toBeGreaterThan(0));
    // The web's own registrations, including Actions (the web cannot tell it is off).
    expect(links(nav)).toContain("Actions /actions");
    expect(links(nav)[0]).toBe("Portal /");
    expect(screen.getByRole("link", { name: "Deck" })).toHaveAttribute("href", "/");
    expect(screen.getByRole("button", { name: /^Theme: / })).toBeInTheDocument();
  });

  it("lists the fallback groups in the built-in order when the manifest cannot be read", async () => {
    const nav = await renderApp(() => new Response(null, { status: 500 }));
    await waitFor(() => expect(links(nav).length).toBeGreaterThan(0));
    const headings = [...nav.querySelectorAll('[data-sidebar="group-label"]')].map((label) => label.textContent);
    expect(headings).toEqual(["Overview", "Inventory", "Health", "Operate", "Knowledge"]);
  });

  it.each([
    ["nav: [null]", { nav: [null] }],
    ["extensions: [null]", { extensions: [null] }],
    ["navGroups: [null]", { navGroups: [null] }],
  ])("a malformed manifest (%s) takes the fallback, and a later healthy one heals it", async (_label, patch) => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let healthy = false;
    const nav = await renderApp(() => Response.json(healthy ? golden : { ...golden, ...patch }));
    // The fallback lists the web's registrations, Actions included; no theme menu is lost.
    await waitFor(() => expect(links(nav)).toContain("Actions /actions"));
    expect(screen.getByRole("button", { name: /^Theme: / })).toBeInTheDocument();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("UI manifest unavailable"), expect.anything());

    healthy = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_DEFAULTS.pollIntervalMs + 100);
    });
    await waitFor(() => expect(links(nav)).not.toContain("Actions /actions"));
    expect(links(nav)[0]).toBe("Portal /");
    vi.useRealTimers();
  });

  it("names the home link before the manifest arrives", async () => {
    await renderApp(() => new Promise<Response>(() => {}) as unknown as Response);
    expect(screen.getByRole("link", { name: "Deck" })).toHaveAttribute("href", "/");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  });

  it("lists no nav entries before the manifest arrives", async () => {
    let answer: (response: Response) => void = () => {};
    const nav = await renderApp(() => new Promise<Response>((resolve) => { answer = resolve; }) as unknown as Response);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(links(nav)).toEqual([]);
    await act(async () => {
      answer(Response.json(golden));
    });
    await waitFor(() => expect(links(nav).length).toBe(8));
  });
});
