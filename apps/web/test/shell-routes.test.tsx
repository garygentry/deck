// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { UiManifest, UiModule } from "@deck/module-sdk";
import { primary } from "@deck/schema/fixtures";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { UiManifestState } from "../src/data/index.js";
import { resetQueryClient } from "../src/data/query-client.js";
import type { PageRegistration } from "../src/registry/registry.js";
import { ModuleNotEnabledPage } from "../src/shell/ModuleNotEnabledPage.js";
import { resolveRoutes, type NotEnabledRoute } from "../src/shell/routes.js";

/**
 * Capability-aware routing: a page of a module the UI manifest lists as disabled is not
 * routed; its path says the module is off and names the setting that turns it on. The server
 * golden for the example estate (default env: actions off) is what the real server serves.
 */
const TEST_FILE_URL = import.meta.url;
const golden = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../server/test/golden/ui/examples-estate.json", TEST_FILE_URL)), "utf8"),
) as UiManifest;

const Component = () => null;
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
    page("page:portal/overview", "/", "Portal"),
    page("page:actions/overview", "/actions", "Actions"),
    page("page:_ui/workbench", "/_ui", "UI workbench"),
  ];

  it("does not route a disabled module's page, and answers its path as not enabled", () => {
    const routes = resolveRoutes(ready(golden), pages);
    expect(ids(routes.routed)).toEqual(["page:portal/overview", "page:_ui/workbench"]);
    expect(routes.notEnabled).toEqual([
      { id: "page:actions/overview", path: "/actions", label: "Actions", module: golden.modules.find((m) => m.id === "actions") },
    ]);
    expect(routes.notEnabled[0]?.module?.enabledBy).toEqual({ env: "DECK_ACTIONS_ENABLED" });
  });

  it("does not route a page of a module listed as disabled even without a disabled page for it", () => {
    const manifest: UiManifest = { ...golden, disabledPages: [] };
    expect(ids(resolveRoutes(ready(manifest), pages).routed)).not.toContain("page:actions/overview");
  });

  it("routes every registered page until the manifest loads, or when it cannot be read", () => {
    for (const state of [{ status: "loading" }, { status: "error", message: "down" }] as UiManifestState[]) {
      expect(resolveRoutes(state, pages)).toEqual({ routed: pages, notEnabled: [] });
    }
  });

  it("routes every registered page for an older server's manifest (no modules or disabled pages)", () => {
    const older = { ...golden, modules: undefined, disabledPages: undefined } as unknown as UiManifest;
    expect(resolveRoutes(ready(older), pages)).toEqual({ routed: pages, notEnabled: [] });
  });
});

describe("ModuleNotEnabledPage", () => {
  const route = (module: UiModule | undefined): NotEnabledRoute => ({ id: "page:tools/overview", path: "/tools", label: "Tools", module });
  const off: UiModule = { id: "tools", version: "1.0.0", enabled: false, origin: "module", reason: "not enabled: TOOLS_ENABLED is not true" };

  it("has one h1 (the page's title) and names the env var that enables the module", () => {
    render(<ModuleNotEnabledPage route={route({ ...off, enabledBy: { env: "TOOLS_ENABLED" } })} />);
    expect(screen.getAllByRole("heading", { level: 1 }).map((h) => h.textContent)).toEqual(["Tools"]);
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("The tools module is not enabled");
    expect(status).toHaveTextContent("Set TOOLS_ENABLED=true in deck's environment and restart deck.");
    expect(screen.getByRole("link", { name: "Go to the portal" })).toHaveAttribute("href", "/");
  });

  it("names the config key when a config section enables the module", () => {
    render(<ModuleNotEnabledPage route={route({ ...off, enabledBy: { config: "modules.tools" } })} />);
    expect(screen.getByRole("status")).toHaveTextContent("Add a modules.tools section to the estate config and restart deck.");
  });

  it("gives the module's reason when no setting would enable it", () => {
    render(<ModuleNotEnabledPage route={route({ ...off, reason: 'Module "tools" depends on "x", which is not available.' })} />);
    expect(screen.getByRole("status")).toHaveTextContent('Module "tools" depends on "x", which is not available.');
  });
});

describe("the shell at a disabled module's path", () => {
  async function renderApp(ui: () => Response | Promise<Response>, path: string) {
    vi.resetModules();
    const requests: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      requests.push(url);
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
    const { App } = await import("../src/shell/App.js");
    render(<App />);
    return { requests };
  }

  it("renders the not-enabled page naming the env var, and the actions page never loads", async () => {
    const { requests } = await renderApp(() => Response.json(golden), "/actions");
    const main = screen.getByRole("main");
    await waitFor(() => expect(within(main).getByRole("status")).toHaveTextContent("Set DECK_ACTIONS_ENABLED=true"));
    expect(within(main).getAllByRole("heading", { level: 1 }).map((h) => h.textContent)).toEqual(["Actions"]);
    expect(main.querySelector('[data-slot="module-not-enabled-page"]')).not.toBeNull();
    await waitFor(() => expect(document.title).toBe("Actions · example-estate"));
    // Not listed in the nav either.
    const nav = screen.getByRole("navigation", { name: "Primary" });
    expect(within(nav).queryByRole("link", { name: "Actions" })).not.toBeInTheDocument();
    expect(requests.some((url) => url.startsWith("/api/actions"))).toBe(false);
  });

  it("routes the page while the manifest is still loading (no not-found flash)", async () => {
    await renderApp(() => new Promise<Response>(() => {}), "/actions");
    expect(await screen.findByRole("heading", { name: "Actions", level: 1 })).toBeInTheDocument();
    expect(screen.queryByText("Page not found")).not.toBeInTheDocument();
    expect(document.querySelector('[data-slot="module-not-enabled-page"]')).toBeNull();
  });
});
