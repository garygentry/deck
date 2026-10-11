import { renderHtml as render } from "./support/render.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const Home = () => <div data-testid="home-page">home</div>;
const Hosts = () => <div data-testid="hosts-page">hosts</div>;
const Services = () => <div data-testid="services-page">services</div>;
const HostDetail = () => <div data-testid="host-detail-page">host detail</div>;
const ServiceDetail = () => <div data-testid="service-detail-page">service detail</div>;

async function setup() {
  const registry = await import("../src/registry/registry.js");
  // Existing-style registrations with nav omitted must stay visible.
  registry.registerPage({ id: "page:core/home", path: "/", label: "Home", component: Home });
  registry.registerPage({ id: "page:inventory/hosts", path: "/hosts", label: "Hosts", component: Hosts });
  registry.registerPage({
    id: "page:inventory/services",
    path: "/services",
    label: "Services",
    component: Services,
  });
  // Both synthetic navigation-hidden dynamic routes remain routable.
  registry.registerPage({
    id: "page:inventory/host-detail",
    path: "/hosts/:name",
    label: "Host",
    component: HostDetail,
    nav: false,
  });
  registry.registerPage({
    id: "page:inventory/service-detail",
    path: "/services/:host/:name",
    label: "Service",
    component: ServiceDetail,
    nav: false,
  });
  // The sidebar lists the UI manifest's nav (here, the three listed pages).
  const { getQueryClient } = await import("../src/data/query-client.js");
  const nav = (page: string, group: string, label: string) => ({
    id: page.replace("page:", "nav:"), module: page.split(/[:/]/)[1], slot: "app/nav", page, group, label, order: 100,
  });
  getQueryClient().setQueryData(["ui"], {
    uiApi: 1, brand: { title: "Lab" }, modules: [], slots: [], pages: [], disabledPages: [], extensions: [], providers: [], findings: [],
    navGroups: [{ id: "overview", label: "Overview" }, { id: "inventory", label: "Inventory" }],
    nav: [
      nav("page:core/home", "overview", "Home"),
      nav("page:inventory/hosts", "inventory", "Hosts"),
      nav("page:inventory/services", "inventory", "Services"),
    ],
  });
  const { App } = await import("../src/shell/App.js");
  return { App };
}

function navLinks(html: string): string[] {
  const nav = html.match(/<nav[^>]*>([\s\S]*?)<\/nav>/)?.[1] ?? "";
  return [...nav.matchAll(/href="([^"]*)"/g)].map((match) => match[1]);
}

describe("shell navigation and routing", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("routes every page; primary navigation lists the manifest's entries", async () => {
    vi.stubGlobal("location", new URL("http://localhost/"));
    const { App } = await setup();

    const html = render(<App />);

    // The detail routes have no nav entry.
    expect(navLinks(html)).toEqual(["/", "/hosts", "/services"]);
    expect(html).not.toContain('href="/hosts/:name"');
    expect(html).not.toContain('href="/services/:host/:name"');
    // Route order is unchanged (matches getPages order).
    const { getPages } = await import("../src/registry/registry.js");
    // Sorted by order then id; routing preserves it verbatim.
    expect(getPages().map((page) => page.id)).toEqual([
      "page:core/home",
      "page:inventory/host-detail",
      "page:inventory/hosts",
      "page:inventory/service-detail",
      "page:inventory/services",
    ]);
  });

  it("renders each nav-hidden dynamic route when navigated to directly", async () => {
    vi.stubGlobal("location", new URL("http://localhost/hosts/server-1"));
    const { App: HostApp } = await setup();
    expect(render(<HostApp />)).toContain('data-testid="host-detail-page"');

    vi.resetModules();
    vi.stubGlobal("location", new URL("http://localhost/services/server-1/api"));
    const { App: ServiceApp } = await setup();
    const serviceHtml = render(<ServiceApp />);
    expect(serviceHtml).toContain('data-testid="service-detail-page"');
    // Both detail routes stay absent from primary navigation.
    expect(navLinks(serviceHtml)).toEqual(["/", "/hosts", "/services"]);
  });

  it("lists the nav entries in the manifest's order", async () => {
    vi.stubGlobal("location", new URL("http://localhost/hosts"));
    const { App } = await setup();

    const html = render(<App />);

    expect(navLinks(html)).toEqual(["/", "/hosts", "/services"]);
    expect(html).toContain('data-testid="hosts-page"');
  });
});
