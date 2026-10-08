// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { UiManifest } from "@deck/module-sdk";
import { primary } from "@deck/schema/fixtures";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { UiManifestState } from "../src/data/index.js";
import { resetQueryClient } from "../src/data/query-client.js";
import type { PageRegistration } from "../src/registry/registry.js";
import { ModuleNotEnabledPage } from "../src/shell/ModuleNotEnabledPage.js";
import { moduleSwitches, resolveHome, resolveRoutes, routeForPath, type NotEnabledRoute } from "../src/shell/routes.js";

/**
 * Capability-aware routing: a page the UI manifest lists as a disabled module's page is not
 * routed; its path says the module is off and names the settings that turn it on. The server
 * golden for the example estate (default env: actions off) is what the real server serves.
 */
const TEST_FILE_URL = import.meta.url;
const golden = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../server/test/golden/ui/examples-estate.json", TEST_FILE_URL)), "utf8"),
) as UiManifest;

const Component = () => null;

// The not-enabled page's way home follows the router's home page (mocked: no manifest here).
let mockHome: PageRegistration | undefined;
vi.mock("../src/shell/use-home.js", () => ({ useHomePage: () => mockHome }));
const page = (id: string, path: string, label: string): PageRegistration => ({ id: id as PageRegistration["id"], path, label, component: Component });
const ready = (manifest: UiManifest): UiManifestState => ({ status: "ready", manifest });
const ids = (list: readonly { id: string }[]) => list.map((entry) => entry.id);

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetQueryClient();
});

describe("resolveRoutes", () => {
  const pages = [
    page("page:portal/overview", "/portal", "Portal"),
    page("page:actions/overview", "/actions", "Actions"),
    page("page:_ui/workbench", "/_ui", "UI workbench"),
  ];

  it("does not route a disabled module's page, and answers its path as not enabled", () => {
    const routes = resolveRoutes(ready(golden), pages);
    expect(ids(routes.routed)).toEqual(["page:portal/overview", "page:_ui/workbench"]);
    expect(routes.notEnabled).toEqual([
      {
        id: "page:actions/overview",
        path: "/actions",
        label: "Actions",
        module: "actions",
        enabledBy: [{ env: "DECK_ACTIONS_ENABLED" }],
        reason: "not enabled: DECK_ACTIONS_ENABLED is not true",
      },
    ]);
  });

  it("does not route any page of a disabled module, even one the manifest lists no disabled page for", () => {
    // The module is off, but its page is not a disabled page (an enabled page owns its path).
    const manifest: UiManifest = { ...golden, disabledPages: [] };
    const routes = resolveRoutes(ready(manifest), pages);
    expect(ids(routes.routed)).not.toContain("page:actions/overview");
    expect(routes.notEnabled).toEqual([]);
  });

  it("routes every registered page until the manifest loads, or when it cannot be read", () => {
    for (const state of [{ status: "loading" }, { status: "error", message: "down" }] as UiManifestState[]) {
      expect(resolveRoutes(state, pages)).toEqual({ home: pages[0], routed: pages, notEnabled: [] });
    }
  });

  it("routes every registered page for the previous server's manifest (modules, but no disabled pages)", () => {
    // The real previous shape: the golden without the fields added since.
    const { disabledPages: _dropped, home: _home, ...rest } = golden;
    const previous = { ...rest, modules: golden.modules.map(({ enabledBy: _hint, ...module }) => module) } as UiManifest;
    expect(previous.modules.find((m) => m.id === "actions")).toMatchObject({ enabled: false });
    expect(resolveRoutes(ready(previous), pages)).toEqual({ home: pages[0], routed: pages, notEnabled: [] });
  });
});

describe("the home page", () => {
  const portal = page("page:portal/overview", "/portal", "Portal");
  const hosts = page("page:inventory/hosts", "/hosts", "Hosts");
  const hostDetail = page("page:inventory/host-detail", "/hosts/:name", "Host");
  // A registered page on "/" never takes the home route: home is chosen by id.
  const squatter = page("page:aaa/home", "/", "Squat");
  const routed = [squatter, hostDetail, hosts, portal];
  const withHome = (home: UiManifest["home"]): UiManifestState => ready({ ...golden, home });

  it("is the manifest's home page, routed at / ahead of any page sharing the path", () => {
    expect(resolveHome(withHome({ page: "page:inventory/hosts", path: "/hosts" }), routed)).toBe(hosts);
    const routes = resolveRoutes(withHome({ page: "page:inventory/hosts", path: "/hosts" }), routed);
    expect(routeForPath(routes, "/")).toBe(hosts);
    expect(routeForPath(routes, "/hosts")).toBe(hosts);
    expect(routeForPath(routes, "/portal")).toBe(portal);
  });

  it("is the portal, the default, until the manifest loads, when it cannot be read, or for an older server", () => {
    const { home: _home, ...older } = golden;
    for (const state of [{ status: "loading" }, { status: "error", message: "down" }, ready(older as UiManifest)] as UiManifestState[]) {
      expect(resolveHome(state, routed)).toBe(portal);
    }
    expect(resolveHome({ status: "loading" }, [squatter, hosts])).toBeUndefined();
  });

  it("is none when the manifest says no page can be home (home: null), the portal notwithstanding", () => {
    expect(resolveHome(withHome(null), routed)).toBeUndefined();
    expect(routeForPath(resolveRoutes(withHome(null), routed), "/")).toBeUndefined();
  });

  it("follows the boot object's home id until the manifest is read", () => {
    for (const state of [{ status: "loading" }, { status: "error", message: "down" }] as UiManifestState[]) {
      expect(resolveHome(state, routed, "page:inventory/hosts")).toBe(hosts);
      expect(resolveHome(state, routed, null)).toBeUndefined();
      // An id the web does not route: the default.
      expect(resolveHome(state, routed, "page:nope/overview")).toBe(portal);
    }
    // The manifest, once read, decides.
    expect(resolveHome(withHome({ page: "page:portal/overview", path: "/portal" }), routed, "page:inventory/hosts")).toBe(portal);
  });

  it("is none when the manifest's home is not routed here or has path parameters", () => {
    expect(resolveHome(withHome({ page: "page:nope/overview", path: "/nope" }), routed)).toBeUndefined();
    expect(resolveHome(withHome({ page: "page:inventory/host-detail", path: "/hosts/:name" }), routed)).toBeUndefined();
    // No home in the manifest, and the default is not routed here.
    expect(resolveHome(withHome(undefined), [hosts])).toBeUndefined();
    expect(routeForPath(resolveRoutes(withHome({ page: "page:nope/overview", path: "/nope" }), routed), "/")).toBeUndefined();
  });
});

describe("routing follows the manifest's pages", () => {
  it("does not route a page the manifest does not route (an override switched it off), nor make it home", () => {
    const pages = [page("page:portal/overview", "/portal", "Portal"), page("page:inventory/hosts", "/hosts", "Hosts"), page("page:_ui/workbench", "/_ui", "UI workbench")];
    const manifest: UiManifest = { ...golden, pages: golden.pages.filter((p) => p.id !== "page:portal/overview"), home: null };
    const routes = resolveRoutes(ready(manifest), pages);
    expect(ids(routes.routed)).toEqual(["page:inventory/hosts", "page:_ui/workbench"]);
    expect(routes.home).toBeUndefined();
    expect(routeForPath(routes, "/")).toBeUndefined();
    expect(routeForPath(routes, "/portal")).toBeUndefined();
  });
});

describe("moduleSwitches (lenient)", () => {
  it("keeps entries naming an env var or a config key, ignoring other keys; drops the rest", () => {
    expect(moduleSwitches([{ env: "A", extra: 1 }, { config: "modules.b" }, { env: 1 }, {}, null, "C", { env: "" }])).toEqual([
      { env: "A" },
      { config: "modules.b" },
    ]);
    expect(moduleSwitches({ env: "A" })).toEqual([]);
    expect(moduleSwitches(undefined)).toEqual([]);
  });
});

describe("ModuleNotEnabledPage", () => {
  const route = (parts: Partial<NotEnabledRoute>): NotEnabledRoute => ({
    id: "page:tools/overview", path: "/tools", label: "Tools", module: "tools", enabledBy: [], reason: "not enabled: TOOLS_ENABLED is not true", ...parts,
  });

  it("has one h1 (the page's title) and names the env var that enables the module", () => {
    render(<ModuleNotEnabledPage route={route({ enabledBy: [{ env: "TOOLS_ENABLED" }] })} />);
    expect(screen.getAllByRole("heading", { level: 1 }).map((h) => h.textContent)).toEqual(["Tools"]);
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("The tools module is not enabled");
    expect(status).toHaveTextContent("Set TOOLS_ENABLED=true in deck's environment and restart deck.");
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("links to the home page while some page is home, and offers no link when none is", () => {
    mockHome = page("page:inventory/hosts", "/hosts", "Hosts");
    render(<ModuleNotEnabledPage route={route({})} />);
    expect(screen.getByRole("link", { name: "Go to the home page" })).toHaveAttribute("href", "/");
    cleanup();
    mockHome = undefined;
    render(<ModuleNotEnabledPage route={route({})} />);
    expect(screen.queryByRole("link", { name: "Go to the home page" })).toBeNull();
  });

  it("names the config key when a config section enables the module", () => {
    render(<ModuleNotEnabledPage route={route({ enabledBy: [{ config: "modules.tools" }] })} />);
    expect(screen.getByRole("status")).toHaveTextContent("Add a modules.tools section to the estate config and restart deck.");
  });

  it("names every switch when more than one is unmet", () => {
    render(<ModuleNotEnabledPage route={route({ enabledBy: [{ config: "modules.tools" }, { env: "TOOLS_ENABLED" }, { env: "BASE_ENABLED" }] })} />);
    expect(screen.getByRole("status")).toHaveTextContent(
      "Add a modules.tools section to the estate config, set TOOLS_ENABLED=true in deck's environment, set BASE_ENABLED=true in deck's environment and restart deck.",
    );
  });

  it("gives the module's reason when no setting would enable it", () => {
    render(<ModuleNotEnabledPage route={route({ reason: 'Module "tools" depends on "x", which is not available.' })} />);
    expect(screen.getByRole("status")).toHaveTextContent('Module "tools" depends on "x", which is not available.');
  });
});

describe("the shell at a disabled module's path", () => {
  async function renderApp(ui: () => Response | Promise<Response>, path: string, register?: (registry: typeof import("../src/registry/registry.js")) => void) {
    vi.resetModules();
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === "/api/config") return Response.json(primary.merged);
      if (url === "/api/ui") return ui();
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
    register?.(await import("../src/registry/registry.js"));
    const { App } = await import("../src/shell/App.js");
    render(<App />);
  }

  it("a disabled module's page cannot shadow an enabled page on the same path", async () => {
    const manifest: UiManifest = {
      ...golden,
      modules: [
        ...golden.modules,
        { id: "tools", version: "1.0.0", enabled: false, reason: "not enabled: TOOLS_ENABLED is not true", origin: "module", enabledBy: [{ env: "TOOLS_ENABLED" }] },
        { id: "ops", version: "1.0.0", enabled: true, origin: "module" },
      ],
      // The server routes ops's page and lists no disabled page for tools: ops owns /ops.
      pages: [...golden.pages, { id: "page:ops/overview", module: "ops", path: "/ops", title: "Ops", component: "OpsPage" }],
      disabledPages: golden.disabledPages ?? [],
    };
    await renderApp(() => Response.json(manifest), "/ops", (registry) => {
      // tools is registered first, so it would win the path if it were routed.
      registry.registerPage({ id: "page:tools/ops", path: "/ops", label: "Tools ops", order: -1, nav: false, component: () => <p>tools page</p> });
      registry.registerPage({ id: "page:ops/overview", path: "/ops", label: "Ops", nav: false, component: () => <p>ops page</p> });
    });
    await waitFor(() => expect(document.title).toBe("Ops · example-estate"));
    expect(screen.getByText("ops page")).toBeInTheDocument();
    expect(screen.queryByText("tools page")).not.toBeInTheDocument();
  });

  it("renders the not-enabled page naming the env var, with the page's h1 and no nav link", async () => {
    await renderApp(() => Response.json(golden), "/actions");
    const main = screen.getByRole("main");
    await waitFor(() => expect(main.querySelector('[data-slot="module-not-enabled-page"]')).not.toBeNull());
    expect(within(main).getByRole("status")).toHaveTextContent("Set DECK_ACTIONS_ENABLED=true");
    expect(within(main).getAllByRole("heading", { level: 1 }).map((h) => h.textContent)).toEqual(["Actions"]);
    await waitFor(() => expect(document.title).toBe("Actions · example-estate"));
    const nav = screen.getByRole("navigation", { name: "Primary" });
    expect(within(nav).queryByRole("link", { name: "Actions" })).not.toBeInTheDocument();
  });

  const withBadDisabledPath: UiManifest = {
    ...golden,
    disabledPages: [{ id: "page:tools/broken", module: "tools", path: "/tools/[", title: "Broken" }, ...(golden.disabledPages ?? [])],
  };

  it("a disabled page with a path the router cannot compile does not break another disabled page", async () => {
    await renderApp(() => Response.json(withBadDisabledPath), "/actions");
    const main = screen.getByRole("main");
    await waitFor(() => expect(main.querySelector('[data-slot="module-not-enabled-page"]')).not.toBeNull());
    expect(within(main).getByRole("status")).toHaveTextContent("DECK_ACTIONS_ENABLED=true");
  });

  it("…nor the not-found page", async () => {
    await renderApp(() => Response.json(withBadDisabledPath), "/nowhere");
    await waitFor(() => expect(screen.getByText("Page not found")).toBeInTheDocument());
    // Let the manifest settle, then check routing still answers.
    await waitFor(() => expect(screen.getByRole("navigation", { name: "Primary" }).querySelectorAll("a[href='/hosts']").length).toBe(1));
    expect(screen.getByText("Page not found")).toBeInTheDocument();
  });

  it("routes the page while the manifest is still loading (no not-found flash)", async () => {
    await renderApp(() => new Promise<Response>(() => {}), "/actions");
    expect(await screen.findByRole("heading", { name: "Actions", level: 1 })).toBeInTheDocument();
    expect(screen.queryByText("Page not found")).not.toBeInTheDocument();
    expect(document.querySelector('[data-slot="module-not-enabled-page"]')).toBeNull();
  });
});
