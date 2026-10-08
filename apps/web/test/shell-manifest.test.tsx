// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { UiManifest } from "@deck/module-sdk";
import { POLL_DEFAULTS } from "@deck/contract";
import { primary } from "@deck/schema/fixtures";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { uiManifestProblem, type UiManifestState } from "../src/data/index.js";
import { resetQueryClient } from "../src/data/query-client.js";
import type { Extension, PageRegistration } from "../src/registry/registry.js";
import { brandInitial, brandMark, brandTitle, placeExtensions } from "../src/shell/manifest-slot.js";
import { groupNavPages, isLinkActive, resolveNav, type NavLink } from "../src/shell/nav.js";

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
        icon: "flask-conical",
        links: [
          { id: "nav:a/one", label: "One", icon: undefined, href: "/one" },
          { id: "nav:x/link", label: "Grafana", icon: "chart-line", href: "https://grafana.lab", external: true },
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
    expect(resolveNav(ready(unlabelled), pages)[0]!.links.map((link) => ("label" in link ? link.label : "-"))).toEqual(["One (web)", "nav:x/link"]);
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

  it("files a page under a built-in group by its manifest id only; a heading is just another group", () => {
    const page = (id: string, group: string) => ({ id: `page:${id}/main` as const, path: `/${id}`, label: id, component: () => null, group });
    expect(groupNavPages([page("monitoring", "Health"), page("llm-usage", "health"), page("portal", "overview")])).toEqual([
      { id: "overview", label: "Overview", links: [{ id: "page:portal/main", label: "portal", icon: undefined, href: "/portal" }] },
      { id: "health", label: "Health", links: [{ id: "page:llm-usage/main", label: "llm-usage", icon: undefined, href: "/llm-usage" }] },
      { id: "Health", label: "Health", links: [{ id: "page:monitoring/main", label: "monitoring", icon: undefined, href: "/monitoring" }] },
    ]);
  });

  it("heads groups by id for a manifest without navGroups", () => {
    const old = { ...served, navGroups: undefined } as unknown as UiManifest;
    expect(resolveNav(ready(old), pages).map(({ id, label }) => `${id}:${label}`)).toEqual(["second:second", "first:first"]);
  });
});

describe("resolveNav: config entries", () => {
  const pages = [page("page:a/one", "/one", "One"), page("page:a/two", "/two", "Two")];
  const entry = (id: string, extra: Record<string, unknown>) => ({ id, module: "ui", slot: "app/nav", group: "g", order: 100, ...extra });
  const shaped = (nav: unknown[], navGroups = [{ id: "g", label: "G", icon: "boxes" }]) =>
    resolveNav(ready(manifest({ navGroups, nav: nav as UiManifest["nav"] })), pages);

  it("marks an http(s) link external, and never current", () => {
    const [group] = shaped([entry("nav:ui/grafana", { href: "https://grafana.example.net", label: "Grafana" })]);
    expect(group).toEqual({ id: "g", label: "G", icon: "boxes", links: [{ id: "nav:ui/grafana", label: "Grafana", icon: undefined, href: "https://grafana.example.net", external: true }] });
    expect(isLinkActive(group!.links[0] as NavLink, "/")).toBe(false);
  });

  it("drops an href that is neither an in-app path nor http(s)", () => {
    const groups = shaped([
      entry("nav:ui/bad", { href: "javascript:alert(1)", label: "Bad" }),
      entry("nav:ui/proto", { href: "//evil.example", label: "Proto" }),
      entry("nav:a/one", { page: "page:a/one", label: "One" }),
    ]);
    expect(groups[0]!.links.map((link) => link.id)).toEqual(["nav:a/one"]);
  });

  it("keeps a separator between links only: none at either end, none twice", () => {
    const groups = shaped([
      entry("nav:ui/s1", { separator: true, label: "" }),
      entry("nav:a/one", { page: "page:a/one", label: "One" }),
      entry("nav:ui/s2", { separator: true, label: "" }),
      entry("nav:ui/s3", { separator: true, label: "" }),
      entry("nav:a/two", { page: "page:a/two", label: "Two" }),
      entry("nav:ui/s4", { separator: true, label: "" }),
    ]);
    expect(groups[0]!.links.map((link) => link.id)).toEqual(["nav:a/one", "nav:ui/s2", "nav:a/two"]);
  });

  it("leaves out a group with only separators (or links the web cannot route)", () => {
    expect(shaped([entry("nav:ui/s1", { separator: true, label: "" }), entry("nav:x/gone", { page: "page:x/gone", label: "Gone" })])).toEqual([]);
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

describe("brandMark", () => {
  it("is the logo, else a bundled icon, else the initial", () => {
    expect(brandMark(ready(manifest({ brand: { title: "Lab", icon: "server", logoUrl: "/logo.svg" } })))).toEqual({ kind: "logo", url: "/logo.svg" });
    expect(brandMark(ready(manifest({ brand: { title: "Lab", logoUrl: "https://lab.example/l.png" } })))).toEqual({ kind: "logo", url: "https://lab.example/l.png" });
    expect(brandMark(ready(manifest({ brand: { title: "Lab", icon: "server" } })))).toEqual({ kind: "icon", name: "server" });
    expect(brandMark(ready(manifest({ brand: { title: "Lab", icon: "not-an-icon" } })))).toEqual({ kind: "initial" });
    expect(brandMark(ready(manifest({ brand: { title: "Lab" } })))).toEqual({ kind: "initial" });
  });

  it("ignores a logo URL the server would not send, and reads leniently", () => {
    for (const logoUrl of ["javascript:alert(1)", "//evil.example/x.png", "data:image/png;base64,AA", 3]) {
      expect(brandMark(ready(manifest({ brand: { title: "Lab", logoUrl } as never })))).toEqual({ kind: "initial" });
    }
    expect(brandMark(LOADING)).toEqual({ kind: "initial" });
    expect(brandMark(FAILED)).toEqual({ kind: "initial" });
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
    ["a home without a path", { home: { page: "page:a/b" } }, "home is malformed"],
    ["a module without enabled", { modules: [{ id: "a" }] }, "modules[0] is malformed"],
    ["a disabled page without a path", { disabledPages: [{ id: "page:a/b", module: "a", title: "B" }] }, "disabledPages[0] is malformed"],
    ["pages: [null]", { pages: [null] }, "pages[0] is malformed"],
    ["pages that is not a list", { pages: {} }, "pages is not a list"],
    ["a page without an id", { pages: [{ module: "a", path: "/a", title: "A" }] }, "pages[0] is malformed"],
    ["a home that is not an object", { home: "page:a/b" }, "home is malformed"],
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

  it("renders config links in a new tab with ExternalLink semantics, separators, and group icons", async () => {
    const configured: UiManifest = {
      ...golden,
      navGroups: [{ id: "lab", label: "Lab", icon: "boxes" }, ...golden.navGroups],
      nav: [
        { id: "nav:lab/grafana", module: "ui", slot: "app/nav", href: "https://grafana.example.net", group: "lab", label: "Grafana", icon: "gauge", order: 1 },
        { id: "nav:lab/rule", module: "ui", slot: "app/nav", group: "lab", label: "", order: 2, separator: true },
        { ...golden.nav.find((item) => item.id === "nav:inventory/services")!, group: "lab", order: 3 },
        ...golden.nav.filter((item) => item.id !== "nav:inventory/services"),
      ],
    };
    const nav = await renderApp(() => Response.json(configured));
    const grafana = await within(nav).findByRole("link", { name: "Grafana (opens in new tab)" });
    expect(grafana).toHaveAttribute("href", "https://grafana.example.net");
    expect(grafana).toHaveAttribute("target", "_blank");
    expect(grafana).toHaveAttribute("rel", "noopener noreferrer");
    expect(grafana).not.toHaveAttribute("aria-current");
    expect(links(nav).slice(0, 2)).toEqual(["Grafana (opens in new tab) https://grafana.example.net", "Services /services"]);
    expect(nav.querySelectorAll("[data-nav-separator]")).toHaveLength(1);
    const heading = within(nav).getByText("Lab").parentElement!;
    expect(heading.querySelector('[data-slot="icon"]')).not.toBeNull();
  });

  it("brands the sidebar and the document title with the estate's name", async () => {
    await renderApp(() => Response.json(golden));
    const home = await screen.findByRole("link", { name: "example-estate" });
    expect(home).toHaveAttribute("href", "/");
    await waitFor(() => expect(document.title).toBe("Portal · example-estate"));
  });

  it("renders the brand's icon or logo as the sidebar mark; a logo that fails to load falls back to the initial", async () => {
    await renderApp(() => Response.json({ ...golden, brand: { title: "Lab", icon: "server" } }));
    const link = await screen.findByRole("link", { name: "Lab" });
    await waitFor(() => expect(link.querySelector("[data-brand-mark]")).toHaveAttribute("data-brand-mark", "icon"));
    expect(link.querySelector('[data-brand-mark="icon"] svg')).not.toBeNull();

    cleanup();
    resetQueryClient();
    await renderApp(() => Response.json({ ...golden, brand: { title: "Lab", icon: "server", logoUrl: "/logo.svg" } }));
    const withLogo = await screen.findByRole("link", { name: "Lab" });
    await waitFor(() => expect(withLogo.querySelector("img")).toHaveAttribute("src", "/logo.svg"));
    // Decorative: the link's name is the brand title alone.
    expect(withLogo.querySelector("img")).toHaveAttribute("alt", "");
    fireEvent.error(withLogo.querySelector("img")!);
    expect(withLogo.querySelector("img")).toBeNull();
    expect(withLogo.querySelector('[data-brand-mark="initial"]')).toHaveTextContent("L");
  });

  it("renders the manifest's home page at /, links its nav entry to /, and keeps the portal at /portal", async () => {
    const hostsHome = { ...golden, home: { page: "page:inventory/hosts", path: "/hosts" } } as UiManifest;
    const nav = await renderApp(() => Response.json(hostsHome));
    await waitFor(() => expect(links(nav)).toContain("Hosts /"));
    expect(links(nav).slice(0, 2)).toEqual(["Portal /portal", "Hosts /"]);
    await waitFor(() => expect(document.title).toBe("Hosts · example-estate"));
    expect(within(nav).getByRole("link", { name: "Hosts" })).toHaveAttribute("aria-current", "page");
    expect(await screen.findByRole("heading", { level: 1, name: "Hosts" })).toBeInTheDocument();

    // Its own path still renders it, and keeps its entry current.
    cleanup();
    resetQueryClient();
    const again = await renderApp(() => Response.json(hostsHome), "/hosts");
    await waitFor(() => expect(within(again).getByRole("link", { name: "Hosts" })).toHaveAttribute("aria-current", "page"));
  });

  it("routes neither / nor /portal when an override switches the portal off and no page is home", async () => {
    const off = {
      ...golden,
      pages: golden.pages.filter((p) => p.id !== "page:portal/overview"),
      nav: golden.nav.filter((n) => n.page !== "page:portal/overview"),
      home: null,
    } as UiManifest;
    for (const path of ["/", "/portal"]) {
      cleanup();
      resetQueryClient();
      const nav = await renderApp(() => Response.json(off), path);
      await waitFor(() => expect(links(nav).length).toBeGreaterThan(0));
      expect(await screen.findByText("Page not found")).toBeInTheDocument();
      // No page is home, so the dead end offers no way "home".
      expect(screen.queryByRole("link", { name: "Go to the home page" })).toBeNull();
      expect(links(nav)).not.toContain("Portal /portal");
    }
  });

  it("offers the home page (not the portal) from a dead end when another page is home", async () => {
    const hostsHome = { ...golden, home: { page: "page:inventory/hosts", path: "/hosts" } } as UiManifest;
    await renderApp(() => Response.json(hostsHome), "/nope");
    expect(await screen.findByText("Page not found")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("link", { name: "Go to the home page" })).toHaveAttribute("href", "/"));
    expect(within(screen.getByRole("main")).queryByText(/portal/i)).toBeNull();
  });

  it("renders the portal at / and at /portal by default", async () => {
    await renderApp(() => Response.json(golden), "/portal");
    await waitFor(() => expect(document.title).toBe("Portal · example-estate"));
    const nav = screen.getByRole("navigation", { name: "Primary" });
    await waitFor(() => expect(within(nav).getByRole("link", { name: "Portal" })).toHaveAttribute("aria-current", "page"));
    expect(within(nav).getByRole("link", { name: "Portal" })).toHaveAttribute("href", "/");
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

  it("takes the unavailable path for a malformed pages list: the shell still renders, from the registry", async () => {
    const nav = await renderApp(() => Response.json({ ...golden, pages: [null] }));
    await waitFor(() => expect(links(nav).length).toBeGreaterThan(0));
    // The registry fallback: every registered page, Actions included, and the portal at /.
    expect(links(nav)).toContain("Actions /actions");
    expect(screen.getByRole("link", { name: "Deck" })).toHaveAttribute("href", "/");
    expect(await screen.findByRole("heading", { level: 1, name: "Portal" })).toBeInTheDocument();
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
