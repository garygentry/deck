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
  registry.registerPage({ id: "home", path: "/", label: "Home", component: Home });
  registry.registerPage({ id: "hosts", path: "/hosts", label: "Hosts", component: Hosts });
  registry.registerPage({
    id: "services",
    path: "/services",
    label: "Services",
    component: Services,
  });
  // Both synthetic navigation-hidden dynamic routes remain routable.
  registry.registerPage({
    id: "host-detail",
    path: "/hosts/:name",
    label: "Host",
    component: HostDetail,
    nav: false,
  });
  registry.registerPage({
    id: "service-detail",
    path: "/services/:host/:name",
    label: "Service",
    component: ServiceDetail,
    nav: false,
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

  it("routes every page but hides nav:false registrations from primary navigation", async () => {
    vi.stubGlobal("location", new URL("http://localhost/"));
    const { App } = await setup();

    const html = render(<App />);

    // Primary navigation excludes only nav === false; omitted nav remains visible.
    expect(navLinks(html)).toEqual(["/", "/hosts", "/services"]);
    expect(html).not.toContain('href="/hosts/:name"');
    expect(html).not.toContain('href="/services/:host/:name"');
    // Route order is unchanged (matches getPages order).
    const { getPages } = await import("../src/registry/registry.js");
    // Sorted by order then id; routing preserves it verbatim.
    expect(getPages().map((page) => page.id)).toEqual([
      "home",
      "host-detail",
      "hosts",
      "service-detail",
      "services",
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

  it("keeps existing omitted-nav pages visible in registration order", async () => {
    vi.stubGlobal("location", new URL("http://localhost/hosts"));
    const { App } = await setup();

    const html = render(<App />);

    expect(navLinks(html)).toEqual(["/", "/hosts", "/services"]);
    expect(html).toContain('data-testid="hosts-page"');
  });
});
