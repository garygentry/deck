// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { InventoryData } from "../../../modules/inventory/web/use-inventory-data.js";
import {
  availableState,
  config,
  failedEmptyState,
  hostDecl,
  hostState,
  makeData,
  NOT_CONFIGURED,
  observedHost,
  observedService,
  pendingState,
  requestErrorState,
  serviceDecl,
  snapshotResult,
} from "./inventory-harness.js";

// The mocked context lets tests drive the lists without polling: the provider is
// a passthrough and the context read is stubbed, so the real store never runs.
let inventoryData: InventoryData;
vi.mock("../../../modules/inventory/web/use-inventory-data.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../modules/inventory/web/use-inventory-data.js")>();
  return {
    ...actual,
    InventoryDataProvider: ({ children }: { children: unknown }) => children,
    useInventoryDataContext: () => inventoryData,
  };
});

// Importing the feature entrypoint is the discovery action under test.
import "../../../modules/inventory/web/index.js";
import { HostsPage } from "../../../modules/inventory/web/hosts/list.js";
import { ServicesPage } from "../../../modules/inventory/web/services/list.js";
import { getPages } from "../src/registry/registry.js";
import { resolveComponent } from "./support/lazy.js";

afterEach(cleanup);

// jsdom lacks APIs the Radix popover (facet filters) uses; stub them for this file.
const restores: (() => void)[] = [];
beforeAll(() => {
  class ResizeObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  const g = globalThis as { ResizeObserver?: unknown };
  const previous = g.ResizeObserver;
  g.ResizeObserver = ResizeObserverStub;
  restores.push(() => {
    g.ResizeObserver = previous;
  });
  // Floating UI probes `el.matches(":modal")`, which takes ~20 s per call in jsdom.
  const matches = Element.prototype.matches;
  Element.prototype.matches = function (this: Element, selector: string): boolean {
    if (selector === ":modal" || selector === ":popover-open") return false;
    return matches.call(this, selector);
  };
  restores.push(() => {
    Element.prototype.matches = matches;
  });
  const proto = Element.prototype as unknown as Record<string, unknown>;
  for (const name of ["scrollIntoView", "hasPointerCapture", "releasePointerCapture"]) {
    if (!(name in proto)) {
      proto[name] = () => false;
      restores.push(() => {
        delete proto[name];
      });
    }
  }
});
afterAll(() => {
  for (const restore of restores.reverse()) restore();
});

/** The inventory table, named by its caption. */
function table(name: RegExp): HTMLElement {
  return screen.getByRole("table", { name });
}

/** The body row whose row header is `name`. */
function rowOf(name: string): HTMLElement {
  const header = screen.getAllByRole("rowheader").find((cell) =>
    within(cell).queryByRole("link", { name }) !== null,
  );
  if (header === undefined) throw new Error(`No row for ${name}`);
  return header.closest("tr")!;
}

/** The polite "Showing X of Y" count. */
function count(): HTMLElement {
  return screen.getByText(/^Showing \d+ of \d+/);
}

/** Open a facet popover and toggle one option. */
async function pickFacet(user: ReturnType<typeof userEvent.setup>, facet: string, option: RegExp) {
  await user.click(screen.getByRole("button", { name: new RegExp(`^${facet}`) }));
  const listbox = await screen.findByRole("listbox");
  await user.click(within(listbox).getByRole("option", { name: option }));
  await user.keyboard("{Escape}");
}

// ---------------------------------------------------------------------------
// Hosts: the richly-populated available fixture (all five states, hidden, undeclared).
// ---------------------------------------------------------------------------

function richConfig() {
  return config(
    [
      hostDecl("alpha", { kind: "bare-metal" }),
      hostDecl("bravo", { kind: "vm", hidden: true }),
      hostDecl("charlie", { kind: "lxc" }),
      hostDecl("delta", { kind: "appliance" }),
      hostDecl("echo", { kind: "endpoint" }),
    ],
    [serviceDecl("alpha", "api"), serviceDecl("alpha", "web"), serviceDecl("bravo", "db")],
  );
}

function richAvailable() {
  return availableState(
    snapshotResult({
      hosts: [observedHost("alpha"), observedHost("zeta")],
      services: [observedService("alpha", "api"), observedService("zeta", "edge")],
      hostStates: {
        alpha: hostState("fresh"),
        bravo: hostState("stale"),
        charlie: hostState("partial", { pastStaleThreshold: true }),
        delta: hostState("unreachable"),
        echo: hostState("never-collected"),
        zeta: hostState("fresh"),
      },
    }),
  );
}

const HOSTS_CAPTION = /Hosts inventory: declared intent beside observed reality/;

describe("hosts feature registration", () => {
  it("registers /hosts exactly once as a primary-navigation page", async () => {
    const hosts = getPages().filter((page) => page.id === "page:inventory/hosts");
    expect(hosts).toHaveLength(1);
    expect(hosts[0]).toMatchObject({ path: "/hosts", label: "Hosts" });
    expect(await resolveComponent(hosts[0].component)).toBe(HostsPage);
    expect(hosts[0]!.nav).not.toBe(false);
  });
});

describe("Hosts page structure", () => {
  it("is a labelled page region with a Preflight data-slot root", () => {
    inventoryData = makeData({ config: richConfig(), snapshot: richAvailable() });
    const { container } = render(<HostsPage />);
    const heading = screen.getByRole("heading", { level: 1, name: "Hosts" });
    const page = container.querySelector('[data-slot="hosts-page"]')!;
    expect(page.tagName).toBe("SECTION");
    expect(page).toHaveAttribute("aria-labelledby", heading.id);
    expect(screen.getByRole("search", { name: "Host filters" })).toBeInTheDocument();
  });
});

describe("Hosts table semantics", () => {
  it("renders the caption, grouped headers, six leaf columns, and scopes", () => {
    inventoryData = makeData({ config: richConfig(), snapshot: richAvailable() });
    render(<HostsPage />);
    const hosts = table(HOSTS_CAPTION);
    const headers = within(hosts).getAllByRole("columnheader");
    const byName = (name: string) => headers.find((cell) => cell.textContent === name)!;

    expect(byName("Host")).toHaveAttribute("scope", "colgroup");
    expect(byName("Declared intent")).toHaveAttribute("scope", "colgroup");
    expect(byName("Declared intent")).toHaveAttribute("colSpan", "3");
    expect(byName("Observed reality")).toHaveAttribute("colSpan", "2");
    for (const leaf of ["Name", "Kind", "Purpose", "Declared services", "Collection", "Observed services"]) {
      expect(byName(leaf)).toHaveAttribute("scope", "col");
    }
    expect(within(hosts).getAllByRole("rowheader")[0]).toHaveAttribute("scope", "row");
  });

  it("links every declared and observed-only host to its encoded detail route, in model order", () => {
    inventoryData = makeData({ config: richConfig(), snapshot: richAvailable() });
    render(<HostsPage />);
    const links = within(table(HOSTS_CAPTION))
      .getAllByRole("rowheader")
      .map((cell) => within(cell).getByRole("link"));
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "/hosts/alpha",
      "/hosts/bravo",
      "/hosts/charlie",
      "/hosts/delta",
      "/hosts/echo",
      "/hosts/zeta",
    ]);
    // Every row link carries the DataTable row-link hook the keyboard targets.
    for (const link of links) expect(link).toHaveAttribute("data-row-link");
  });

  it("marks hidden and undeclared rows outside the link name, and renders Not declared intent", () => {
    inventoryData = makeData({ config: richConfig(), snapshot: richAvailable() });
    render(<HostsPage />);
    expect(within(rowOf("bravo")).getByText("Hidden")).toBeInTheDocument();
    const zeta = rowOf("zeta");
    expect(within(zeta).getByText("Undeclared")).toBeInTheDocument();
    expect(within(zeta).getAllByText("Not declared")).toHaveLength(3);
    // The markers never join the link's accessible name.
    expect(within(zeta).getByRole("link", { name: "zeta" })).toBeInTheDocument();
  });

  it("renders all five collection states and the old-partial phrase", () => {
    inventoryData = makeData({ config: richConfig(), snapshot: richAvailable() });
    render(<HostsPage />);
    const expected: Record<string, string> = {
      alpha: "Fresh",
      bravo: "Stale",
      charlie: "Partial",
      delta: "Unreachable",
      echo: "Never collected",
    };
    for (const [host, label] of Object.entries(expected)) {
      expect(within(rowOf(host)).getByText(label)).toBeInTheDocument();
    }
    expect(within(rowOf("charlie")).getByText(/Past stale threshold/)).toBeInTheDocument();
  });

  it("renders separate declared and observed service counts", () => {
    inventoryData = makeData({ config: richConfig(), snapshot: richAvailable() });
    render(<HostsPage />);
    const cells = within(rowOf("alpha")).getAllByRole("cell");
    // Kind, Purpose, Declared services, Collection, Observed services.
    expect(cells[2]).toHaveTextContent(/^2$/);
    expect(cells[4]).toHaveTextContent(/^1$/);
  });

  it("announces the exact visible/total/hidden count politely", () => {
    inventoryData = makeData({ config: richConfig(), snapshot: richAvailable() });
    render(<HostsPage />);
    expect(count()).toHaveTextContent("Showing 6 of 6; 0 hidden by filters.");
    expect(count()).toHaveAttribute("role", "status");
    expect(count()).toHaveAttribute("aria-live", "polite");
  });

  it("encodes route segments with reserved characters", () => {
    inventoryData = makeData({ config: config([hostDecl("a b")]), snapshot: NOT_CONFIGURED });
    render(<HostsPage />);
    expect(screen.getByRole("link", { name: "a b" })).toHaveAttribute("href", "/hosts/a%20b");
  });
});

describe("Hosts snapshot and error states", () => {
  it("keeps declared rows with No snapshot reality and disables the reality facet", () => {
    inventoryData = makeData({ config: richConfig(), snapshot: NOT_CONFIGURED });
    const { container } = render(<HostsPage />);
    expect(screen.getByRole("link", { name: "alpha" })).toHaveAttribute("href", "/hosts/alpha");
    // Both reality cells report No snapshot; no host state chip is fabricated.
    expect(within(rowOf("alpha")).getAllByText("No snapshot")).toHaveLength(2);
    expect(container.querySelector("[data-host-state]")).toBeNull();
    // The page-level cause is explained and the reality facet is disabled.
    expect(screen.getByRole("heading", { name: "No snapshot configured" })).toBeInTheDocument();
    expect(screen.getByText("Snapshot data is unavailable.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Freshness/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /^Kind/ })).toBeEnabled();
  });

  it("renders pending, failed-empty, and request-error page status", () => {
    inventoryData = makeData({ config: richConfig(), snapshot: pendingState() });
    const { unmount } = render(<HostsPage />);
    expect(screen.getByRole("heading", { name: "Snapshot pending" })).toBeInTheDocument();
    unmount();

    inventoryData = makeData({ config: richConfig(), snapshot: failedEmptyState("First poll failed.") });
    const failed = render(<HostsPage />);
    expect(screen.getByRole("alert")).toHaveTextContent("Snapshot unavailable");
    expect(screen.getByText("First poll failed.")).toBeInTheDocument();
    failed.unmount();

    inventoryData = makeData({
      config: richConfig(),
      snapshot: requestErrorState("Snapshot request failed; check the deck server connection."),
    });
    render(<HostsPage />);
    expect(screen.getByRole("alert")).toHaveTextContent("Snapshot request failed");
    expect(screen.getByText(/check the deck server connection\./)).toBeInTheDocument();
  });

  it("preserves reality while alerting a retained read failure", () => {
    inventoryData = makeData({
      config: richConfig(),
      snapshot: availableState(
        snapshotResult({
          hosts: [observedHost("alpha")],
          hostStates: { alpha: hostState("fresh") },
          readError: { code: "POLL_TIMEOUT", message: "Snapshot read timed out." },
        }),
        { message: "outer failure" },
      ),
    });
    render(<HostsPage />);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Latest snapshot read failed; showing the last successful snapshot.");
    expect(alert).toHaveTextContent("Snapshot read timed out.");
    // The host collection chip is unaffected by the provider failure.
    expect(within(rowOf("alpha")).getByText("Fresh")).toBeInTheDocument();
  });

  it("renders a config-error alert while still diagnosing the snapshot", () => {
    inventoryData = makeData({
      config: null,
      configError: "Config response is invalid; check the deck server.",
      snapshot: requestErrorState("Snapshot request failed; check the deck server connection."),
    });
    render(<HostsPage />);
    const alerts = screen.getAllByRole("alert");
    expect(
      alerts.some((alert) =>
        alert.textContent?.includes(
          "Inventory configuration unavailable: Config response is invalid; check the deck server.",
        ),
      ),
    ).toBe(true);
    // The independent snapshot diagnosis still renders; no fabricated table.
    expect(alerts.some((alert) => alert.textContent?.includes("Snapshot request failed"))).toBe(true);
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("shows the full-empty row with headers intact", () => {
    inventoryData = makeData({ config: config([], []), snapshot: NOT_CONFIGURED });
    render(<HostsPage />);
    const hosts = table(HOSTS_CAPTION);
    expect(within(hosts).getByRole("status")).toHaveTextContent("No hosts are declared or observed.");
    expect(within(hosts).getByRole("columnheader", { name: "Name" })).toBeInTheDocument();
  });

  it("shows a loading status before the first generation commits", () => {
    inventoryData = makeData({ config: null, snapshot: pendingState(), loading: true });
    render(<HostsPage />);
    expect(screen.getByRole("status", { name: "Loading inventory…" })).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
  });
});

describe("Hosts search and filters", () => {
  it("composes search locally, updating rows and the exact count", async () => {
    const user = userEvent.setup();
    inventoryData = makeData({ config: richConfig(), snapshot: richAvailable() });
    render(<HostsPage />);
    const search = screen.getByRole("searchbox", { name: "Search hosts" });

    await user.type(search, "al");
    expect(within(table(HOSTS_CAPTION)).getAllByRole("rowheader")).toHaveLength(1);
    expect(count()).toHaveTextContent("Showing 1 of 6; 5 hidden by filters.");

    await user.clear(search);
    await user.type(search, "zzzzz");
    expect(within(table(HOSTS_CAPTION)).queryAllByRole("rowheader")).toHaveLength(0);
    expect(screen.getByText("No hosts match the current search and filters.")).toBeInTheDocument();
    expect(count()).toHaveTextContent("Showing 0 of 6; 6 hidden by filters.");
  });

  it("filters by kind and freshness, with removable chips", async () => {
    const user = userEvent.setup();
    inventoryData = makeData({ config: richConfig(), snapshot: richAvailable() });
    render(<HostsPage />);

    await pickFacet(user, "Kind", /^lxc/);
    expect(count()).toHaveTextContent("Showing 1 of 6; 5 hidden by filters.");
    await user.click(screen.getByRole("button", { name: "Remove kind filter lxc" }));
    expect(count()).toHaveTextContent("Showing 6 of 6; 0 hidden by filters.");

    await pickFacet(user, "Freshness", /^Fresh/);
    expect(count()).toHaveTextContent("Showing 2 of 6; 4 hidden by filters.");
    await user.click(screen.getByRole("button", { name: "Clear all" }));
    expect(count()).toHaveTextContent("Showing 6 of 6; 0 hidden by filters.");
  });

  it("excludes hidden hosts from the exclude-hidden checkbox", async () => {
    const user = userEvent.setup();
    inventoryData = makeData({ config: richConfig(), snapshot: richAvailable() });
    render(<HostsPage />);
    const exclude = screen.getByRole("checkbox", { name: "Exclude hidden hosts" });
    await user.click(exclude);
    expect(exclude).toBeChecked();
    expect(count()).toHaveTextContent("Showing 5 of 6; 1 hidden by filters.");
    expect(screen.queryByRole("link", { name: "bravo" })).toBeNull();
  });

  it("clears reality filters when the snapshot becomes unavailable", async () => {
    const user = userEvent.setup();
    inventoryData = makeData({ config: richConfig(), snapshot: richAvailable() });
    const { rerender } = render(<HostsPage />);

    await pickFacet(user, "Freshness", /^Fresh/);
    expect(count()).toHaveTextContent("Showing 2 of 6; 4 hidden by filters.");

    // Transition to no snapshot: the reality filter is cleared, not left stuck.
    inventoryData = makeData({ config: richConfig(), snapshot: NOT_CONFIGURED });
    rerender(<HostsPage />);
    // Observed-only zeta is gone with the snapshot; all 5 declared rows show.
    expect(count()).toHaveTextContent("Showing 5 of 5; 0 hidden by filters.");
  });
});

describe("Hosts lifecycle status", () => {
  it("renders the service-identical lifecycle badges, independent of hidden", () => {
    inventoryData = makeData({
      config: config([
        hostDecl("alpha", { status: "retired" }),
        hostDecl("bravo", { status: "planned", hidden: true }),
        hostDecl("charlie"),
      ]),
      snapshot: NOT_CONFIGURED,
    });
    render(<HostsPage />);
    expect(within(rowOf("alpha")).getByText("Retired")).toBeInTheDocument();
    expect(within(rowOf("alpha")).queryByText("Hidden")).toBeNull();
    expect(within(rowOf("bravo")).getByText("Planned")).toBeInTheDocument();
    expect(within(rowOf("bravo")).getByText("Hidden")).toBeInTheDocument();
    // An omitted status renders no lifecycle badge (and never looks active).
    const charlie = rowOf("charlie");
    expect(within(charlie).queryByText("Active")).toBeNull();
    expect(within(charlie).queryByText("Hidden")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Services: every lifecycle, every observed state, hidden/undeclared/not-observed/
// unspecified, and a duplicate name across hosts.
// ---------------------------------------------------------------------------

function richServicesConfig() {
  return config(
    [hostDecl("alpha"), hostDecl("bravo")],
    [
      serviceDecl("alpha", "api", { status: "active" }),
      serviceDecl("alpha", "cache", { status: "retired" }),
      serviceDecl("alpha", "web", { status: "planned", hidden: true }),
      // Omitted status → Unspecified; duplicate name "api" on a different host.
      serviceDecl("bravo", "api"),
      // Declared but never observed → Not observed under an available snapshot.
      serviceDecl("bravo", "worker"),
    ],
  );
}

function richServicesAvailable() {
  return availableState(
    snapshotResult({
      hosts: [observedHost("alpha"), observedHost("bravo"), observedHost("charlie")],
      services: [
        observedService("alpha", "api", { state: "running" }),
        observedService("alpha", "cache", { state: "degraded" }),
        observedService("alpha", "web", { state: "stopped" }),
        observedService("bravo", "api", { state: "unknown" }),
        observedService("charlie", "ghost", { state: "running" }),
      ],
      hostStates: {
        alpha: hostState("fresh"),
        bravo: hostState("stale"),
        charlie: hostState("fresh"),
      },
    }),
  );
}

const SERVICES_CAPTION = /Services inventory: declared intent beside observed reality/;

/** The service row for `(host, name)`. */
function serviceRow(host: string, name: string): HTMLElement {
  const link = screen
    .getAllByRole("link", { name })
    .find((candidate) => candidate.getAttribute("href") === `/services/${host}/${name}`);
  if (link === undefined) throw new Error(`No row for ${host}/${name}`);
  return link.closest("tr")!;
}

describe("services feature registration", () => {
  it("registers /services exactly once as a primary-navigation page", async () => {
    const services = getPages().filter((page) => page.id === "page:inventory/services");
    expect(services).toHaveLength(1);
    expect(services[0]).toMatchObject({ path: "/services", label: "Services" });
    expect(await resolveComponent(services[0].component)).toBe(ServicesPage);
    expect(services[0]!.nav).not.toBe(false);
  });
});

describe("Services table semantics", () => {
  it("renders the caption, grouped headers, seven leaf columns, and scopes", () => {
    inventoryData = makeData({ config: richServicesConfig(), snapshot: richServicesAvailable() });
    const { container } = render(<ServicesPage />);
    expect(container.querySelector('[data-slot="services-page"]')).not.toBeNull();
    const services = table(SERVICES_CAPTION);
    const headers = within(services).getAllByRole("columnheader");
    const byName = (name: string) => headers.find((cell) => cell.textContent === name)!;

    expect(byName("Service")).toHaveAttribute("colSpan", "2");
    expect(byName("Declared intent")).toHaveAttribute("colSpan", "3");
    expect(byName("Observed reality")).toHaveAttribute("colSpan", "2");
    for (const group of ["Service", "Declared intent", "Observed reality"]) {
      expect(byName(group)).toHaveAttribute("scope", "colgroup");
    }
    for (const leaf of ["Name", "Host", "Kind", "Lifecycle", "Purpose", "Observed state", "Host collection"]) {
      expect(byName(leaf)).toHaveAttribute("scope", "col");
    }
  });

  it("keeps independent host/name identity, duplicate names, and host-then-name order", () => {
    inventoryData = makeData({ config: richServicesConfig(), snapshot: richServicesAvailable() });
    render(<ServicesPage />);
    const hrefs = within(table(SERVICES_CAPTION))
      .getAllByRole("rowheader")
      .map((cell) => within(cell).getByRole("link").getAttribute("href"));
    expect(hrefs).toEqual([
      "/services/alpha/api",
      "/services/alpha/cache",
      "/services/alpha/web",
      "/services/bravo/api",
      "/services/bravo/worker",
      "/services/charlie/ghost",
    ]);
    // Host cells link to the host detail route, never a joined key.
    expect(within(serviceRow("bravo", "api")).getByRole("link", { name: "bravo" })).toHaveAttribute(
      "href",
      "/hosts/bravo",
    );
  });

  it("renders every lifecycle, observed state, and distinct marker label", () => {
    inventoryData = makeData({ config: richServicesConfig(), snapshot: richServicesAvailable() });
    render(<ServicesPage />);
    const cases: [string, string, string[]][] = [
      ["alpha", "api", ["Active", "Running", "Fresh"]],
      ["alpha", "cache", ["Retired", "Degraded"]],
      ["alpha", "web", ["Planned", "Stopped", "Hidden"]],
      ["bravo", "api", ["Unspecified", "Unknown", "Stale"]],
      ["bravo", "worker", ["Not observed"]],
      ["charlie", "ghost", ["Undeclared", "Not declared", "Running"]],
    ];
    for (const [host, name, labels] of cases) {
      const row = serviceRow(host, name);
      for (const label of labels) expect(within(row).getAllByText(label).length).toBeGreaterThan(0);
    }
  });

  it("announces the exact visible/total/hidden count politely", () => {
    inventoryData = makeData({ config: richServicesConfig(), snapshot: richServicesAvailable() });
    render(<ServicesPage />);
    expect(count()).toHaveTextContent("Showing 6 of 6; 0 hidden by filters.");
    expect(count()).toHaveAttribute("aria-live", "polite");
  });

  it("encodes host and name route segments independently", () => {
    inventoryData = makeData({
      config: config([hostDecl("a b")], [serviceDecl("a b", "c d")]),
      snapshot: NOT_CONFIGURED,
    });
    render(<ServicesPage />);
    expect(screen.getByRole("link", { name: "c d" })).toHaveAttribute("href", "/services/a%20b/c%20d");
    expect(screen.getByRole("link", { name: "a b" })).toHaveAttribute("href", "/hosts/a%20b");
  });
});

describe("Services snapshot and error states", () => {
  it("keeps declared rows with No snapshot reality and never says Not observed", () => {
    inventoryData = makeData({ config: richServicesConfig(), snapshot: NOT_CONFIGURED });
    const { container } = render(<ServicesPage />);
    const api = serviceRow("alpha", "api");
    expect(within(api).getByText("Active")).toBeInTheDocument();
    expect(within(api).getAllByText("No snapshot")).toHaveLength(2);
    const services = table(SERVICES_CAPTION);
    expect(within(services).queryByText("Not observed")).toBeNull();
    expect(container.querySelector("[data-host-state]")).toBeNull();
    // Reality controls disabled and explained.
    expect(screen.getByText("Snapshot data is unavailable.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Observed state/ })).toBeDisabled();
  });

  it("preserves observed reality while alerting a retained read failure", () => {
    inventoryData = makeData({
      config: config([hostDecl("alpha")], [serviceDecl("alpha", "api", { status: "active" })]),
      snapshot: availableState(
        snapshotResult({
          hosts: [observedHost("alpha")],
          services: [observedService("alpha", "api", { state: "running" })],
          hostStates: { alpha: hostState("fresh") },
          readError: { code: "POLL_TIMEOUT", message: "Snapshot read timed out." },
        }),
        { message: "outer failure" },
      ),
    });
    render(<ServicesPage />);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Latest snapshot read failed; showing the last successful snapshot.",
    );
    const api = serviceRow("alpha", "api");
    expect(within(api).getByText("Running")).toBeInTheDocument();
    expect(within(api).getByText("Fresh")).toBeInTheDocument();
  });

  it("shows the full-empty row with all seven headers intact", () => {
    inventoryData = makeData({ config: config([], []), snapshot: NOT_CONFIGURED });
    render(<ServicesPage />);
    const services = table(SERVICES_CAPTION);
    const empty = within(services).getByRole("status");
    expect(empty).toHaveTextContent("No services are declared or observed.");
    expect(empty.closest("td")).toHaveAttribute("colSpan", "7");
    expect(within(services).getByRole("columnheader", { name: "Observed state" })).toBeInTheDocument();
  });

  it("renders a config-error alert while still diagnosing the snapshot", () => {
    inventoryData = makeData({
      config: null,
      configError: "Config response is invalid; check the deck server.",
      snapshot: requestErrorState("Snapshot request failed; check the deck server connection."),
    });
    render(<ServicesPage />);
    const text = screen.getAllByRole("alert").map((alert) => alert.textContent).join(" | ");
    expect(text).toContain(
      "Inventory configuration unavailable: Config response is invalid; check the deck server.",
    );
    expect(text).toContain("Snapshot request failed");
    expect(screen.queryByRole("table")).toBeNull();
  });
});

describe("Services search and filters", () => {
  it("composes search over name/host/purpose locally with the exact count", async () => {
    const user = userEvent.setup();
    inventoryData = makeData({ config: richServicesConfig(), snapshot: richServicesAvailable() });
    render(<ServicesPage />);
    const search = screen.getByRole("searchbox", { name: "Search services" });

    // "api" matches the two duplicate-name rows across hosts.
    await user.type(search, "api");
    expect(within(table(SERVICES_CAPTION)).getAllByRole("rowheader")).toHaveLength(2);
    expect(count()).toHaveTextContent("Showing 2 of 6; 4 hidden by filters.");

    // The host field matches every service on that host.
    await user.clear(search);
    await user.type(search, "bravo");
    expect(within(table(SERVICES_CAPTION)).getAllByRole("rowheader")).toHaveLength(2);

    await user.clear(search);
    await user.type(search, "zzzzz");
    expect(within(table(SERVICES_CAPTION)).queryAllByRole("rowheader")).toHaveLength(0);
    expect(screen.getByText("No services match the current search and filters.")).toBeInTheDocument();
  });

  it("filters by host", async () => {
    const user = userEvent.setup();
    inventoryData = makeData({ config: richServicesConfig(), snapshot: richServicesAvailable() });
    render(<ServicesPage />);
    await pickFacet(user, "Host", /^charlie/);
    expect(count()).toHaveTextContent("Showing 1 of 6; 5 hidden by filters.");
    expect(screen.getByRole("button", { name: "Remove host filter charlie" })).toBeInTheDocument();
  });

  it("excludes hidden services without inferring hidden state from the host", async () => {
    const user = userEvent.setup();
    // Host alpha is hidden, but its service is not: the service must still show.
    inventoryData = makeData({
      config: config(
        [hostDecl("alpha", { hidden: true })],
        [serviceDecl("alpha", "visible"), serviceDecl("alpha", "secret", { hidden: true })],
      ),
      snapshot: NOT_CONFIGURED,
    });
    render(<ServicesPage />);
    await user.click(screen.getByRole("checkbox", { name: "Exclude hidden services" }));
    expect(count()).toHaveTextContent("Showing 1 of 2; 1 hidden by filters.");
    expect(screen.getByRole("link", { name: "visible" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "secret" })).toBeNull();
  });

  it("clears observed-state filters when the snapshot becomes unavailable", async () => {
    const user = userEvent.setup();
    inventoryData = makeData({ config: richServicesConfig(), snapshot: richServicesAvailable() });
    const { rerender } = render(<ServicesPage />);

    await pickFacet(user, "Observed state", /^Running/);
    // Declared alpha/api and observed-only charlie/ghost are both running.
    expect(count()).toHaveTextContent("Showing 2 of 6; 4 hidden by filters.");

    inventoryData = makeData({ config: richServicesConfig(), snapshot: NOT_CONFIGURED });
    rerender(<ServicesPage />);
    // All 5 declared services show; the observed-only charlie/ghost is gone.
    expect(count()).toHaveTextContent("Showing 5 of 5; 0 hidden by filters.");
  });
});
