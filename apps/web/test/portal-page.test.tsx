// @vitest-environment jsdom
import type { FreshnessStamp, ProviderEnvelope } from "@deck/contract";
import type { DeckConfig } from "@deck/server";
import type { PortalModuleConfig } from "@deck/server/portal";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DockerResult, GatusResult, PortalData } from "../src/features/portal/card-status.js";

let portalData: PortalData;

vi.mock("../src/features/portal/usePortalData.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/features/portal/usePortalData.js")>();
  return { ...actual, usePortalData: () => portalData };
});

// These side-effect imports intentionally exercise the same registration path as discovery.
import "../src/features/portal/index.js";
import { App } from "../src/shell/App.js";
import {
  orderedGroups,
  orderedItems,
  PortalPage,
  portalGroups,
} from "../src/features/portal/PortalPage.js";
import {
  deriveEndpointSummary,
  EndpointStatusSummary,
} from "../src/features/portal/EndpointStatusSummary.js";
import { CARD_STATUS, PortalCard } from "../src/features/portal/PortalCard.js";
import { getPages } from "../src/registry/registry.js";
import { resetQueryClient } from "../src/data/query-client.js";

const fresh: FreshnessStamp = {
  state: "fresh",
  observedAt: "2026-09-03T00:00:00.000Z",
  ageMs: 12_000,
  ttlMs: 60_000,
};

const docker: ProviderEnvelope<DockerResult> = {
  id: "docker",
  kind: "docker",
  data: {
    containers: [
      { name: "up", state: "running", health: "healthy", status: "Up" },
      { name: "down", state: "exited", health: "none", status: "Exited" },
    ],
  },
  error: null,
  freshness: fresh,
};

const gatus: ProviderEnvelope<GatusResult> = {
  id: "gatus",
  kind: "gatus",
  data: {
    endpoints: [
      { key: "up", up: true, latencyMs: 4 },
      { key: "down", up: false, latencyMs: 8 },
    ],
  },
  error: { message: "gatus unavailable" },
  freshness: { ...fresh, state: "unreachable" },
};

const config: DeckConfig = {
  schemaVersion: 2,
  estate: { name: "Portal component estate" },
  hosts: [
    { name: "atlas", kind: "bare-metal", purpose: "Visible host" },
    { name: "hidden-host", kind: "bare-metal", purpose: "Hidden host", hidden: true },
  ],
  services: [
    service("up", { docker: { container: "up" } }, "https://up.example"),
    service("down", { docker: { container: "down" } }),
    service("missing", { docker: { container: "absent" } }),
    service("unreachable", { gatus: { endpoint: "up" } }),
    service("static", undefined),
    { ...service("hidden", undefined), hidden: true },
    {
      name: "host-hidden",
      host: "hidden-host",
      kind: "external",
      purpose: "Hidden through host",
    },
  ],
  modules: { portal: { groups: [
    {
      id: "z-last",
      title: "Last group",
      items: [{ type: "link", title: "Always visible link", href: "https://link.example" }],
    },
    {
      id: "b-second",
      title: "Second group",
      order: 2,
      items: [
        { type: "service", host: "atlas", name: "up", title: "Up service" },
        { type: "service", host: "atlas", name: "down", title: "Down service" },
        { type: "service", host: "atlas", name: "missing", title: "Missing service" },
        { type: "service", host: "atlas", name: "unreachable", title: "Unreachable service" },
        { type: "service", host: "atlas", name: "static", title: "Static service" },
        { type: "service", host: "atlas", name: "undeclared", title: "Broken service" },
        { type: "service", host: "atlas", name: "hidden", title: "Hidden service" },
        { type: "service", host: "hidden-host", name: "host-hidden", title: "Host-hidden service" },
      ],
    },
    {
      id: "a-first",
      title: "First group",
      order: 1,
      items: [
        { type: "link", title: "Direct item", href: "https://direct.example" },
        {
          type: "group",
          id: "early-subgroup",
          title: "Early subgroup",
          order: 0,
          items: [
            { type: "link", title: "Subgroup Z", href: "https://z.example" },
            { type: "link", title: "Subgroup A", href: "https://a.example" },
          ],
        },
      ],
    },
    {
      id: "hidden-only",
      title: "Hidden only",
      order: 3,
      items: [{ type: "service", host: "atlas", name: "hidden" }],
    },
  ] } },
};

function service(name: string, bindings?: Record<string, unknown>, href?: string) {
  return {
    name,
    host: "atlas",
    kind: "external" as const,
    purpose: `${name} purpose`,
    bindings,
    links: href === undefined ? undefined : [{ title: name, href }],
  };
}

function loaded(overrides: Partial<PortalData> = {}): PortalData {
  return { config, docker, gatus, loading: false, ...overrides };
}

/** Every card (link or inert tile) in document order, by its title. */
function cardTitles(): string[] {
  return [...document.querySelectorAll('[data-slot="link-tile"] [id$="-title"]')].map(
    (el) => el.textContent ?? "",
  );
}

/** The cards that are links (have a target), as the keyboard walks them. */
function cardLinks(): HTMLAnchorElement[] {
  return within(screen.getByTestId("portal"))
    .getAllByRole("link")
    .filter((el): el is HTMLAnchorElement => el.getAttribute("data-slot") === "link-tile");
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
  resetQueryClient();
});

describe("portal registration and assembled page", () => {
  it("owns /", () => {
    portalData = loaded();
    const pages = getPages();
    expect(pages.map(({ id }) => id)).toEqual(["page:portal/overview"]);
    expect(pages[0]).toMatchObject({ id: "page:portal/overview", path: "/", order: -1, component: PortalPage });

    vi.stubGlobal("location", new URL("http://localhost/"));
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: false, media: query, onchange: null,
      addEventListener: () => {}, removeEventListener: () => {},
      addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
    }));
    render(<App />);
    expect(screen.getByRole("heading", { level: 1, name: "Portal" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Portal links" })).not.toBeInTheDocument();
  });

  it("renders one page landmark with no nested <main>", () => {
    portalData = loaded();
    const { container } = render(<PortalPage />);
    expect(container.querySelector("main")).toBeNull();
    const page = screen.getByRole("region", { name: "Portal" });
    expect(page).toHaveAttribute("data-slot", "portal-page");
    expect(within(page).getByRole("search", { name: "Portal filters" })).toBeInTheDocument();
  });

  it("renders deterministic group, item, and subgroup order and applies hidden policy", () => {
    portalData = loaded();
    render(<PortalPage />);
    expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent))
      .toEqual(["First group", "Second group", "Hidden only", "Last group"]);
    expect(screen.getByRole("heading", { level: 3, name: "Early subgroup" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Second group" })).toBeInTheDocument();
    expect(cardTitles()).toEqual([
      "Subgroup Z", "Subgroup A", "Direct item", "Up service", "Down service",
      "Missing service", "Unreachable service", "Static service", "Broken service",
      "Always visible link",
    ]);
    expect(screen.queryByText("Hidden service")).not.toBeInTheDocument();
    expect(screen.queryByText("Host-hidden service")).not.toBeInTheDocument();
    expect(screen.getByText("Broken reference")).toBeInTheDocument();
    const hiddenOnly = screen.getByRole("region", { name: "Hidden only" });
    expect(within(hiddenOnly).getByRole("status")).toHaveTextContent("No visible items.");

    expect(orderedGroups(portalGroups(config)).map(({ id }) => id))
      .toEqual(["a-first", "b-second", "hidden-only", "z-last"]);
    expect(orderedItems(portalGroups(config)[2]?.items ?? []).map((item) => item.type === "group" ? item.id : item.type))
      .toEqual(["early-subgroup", "link"]);
  });

  it.each([undefined, []] as Array<PortalModuleConfig["groups"]>)("renders an accessible empty state for groups=%s", (groups) => {
    portalData = loaded({ config: { ...config, modules: { portal: { groups } } } });
    render(<PortalPage />);
    expect(screen.getByText("No groups configured.").closest('[role="status"]')).not.toBeNull();
  });

  it("shows a loading state until the first config arrives", () => {
    portalData = { config: null, docker: null, gatus: null, loading: true };
    render(<PortalPage />);
    expect(screen.getByRole("status", { name: "Loading the portal…" })).toHaveAttribute("aria-busy", "true");
    expect(screen.queryByText("No groups configured.")).not.toBeInTheDocument();
  });
});

describe("card affordances and targets", () => {
  it("renders all six distinct icon-and-text states, each with a tone", () => {
    portalData = loaded();
    render(<PortalPage />);
    const entries = Object.values(CARD_STATUS);
    expect(new Set(entries.map((value) => value.icon))).toHaveLength(6);
    expect(new Set(entries.map((value) => value.label))).toHaveLength(6);
    expect(CARD_STATUS["not-found"]).not.toEqual(CARD_STATUS["broken-reference"]);
    const page = screen.getByTestId("portal");
    for (const { label, tone } of entries) {
      const badge = within(page).getAllByText(label, { selector: '[data-slot="status-badge"] > span' })[0]!;
      expect(badge.parentElement).toHaveAttribute("data-tone", tone);
      expect(badge.parentElement!.querySelector("svg[aria-hidden='true']")).not.toBeNull();
    }
  });

  it("says Link once on a static link and shows freshness only for polled cards", () => {
    portalData = loaded();
    render(<PortalPage />);
    const link = screen.getByRole("link", { name: "Always visible link" });
    expect(within(link).getAllByText("Link")).toHaveLength(1);
    expect(link.querySelector('[data-slot="freshness-badge"]')).toBeNull();
    const up = screen.getByRole("link", { name: "Up service" });
    expect(within(up).getByText("Fresh")).toBeInTheDocument();
    expect(up).toHaveAccessibleDescription(/Up/);
  });

  it("uses link href and service links[0]; a card without a target is not focusable", () => {
    portalData = loaded();
    render(<PortalPage />);
    expect(screen.getByRole("link", { name: "Always visible link" })).toHaveAttribute("href", "https://link.example");
    expect(screen.getByRole("link", { name: "Up service" })).toHaveAttribute("href", "https://up.example");
    expect(screen.queryByRole("link", { name: "Down service" })).not.toBeInTheDocument();
    const inert = screen.getByText("Down service").closest('[data-slot="link-tile"]')!;
    expect(inert.tagName).toBe("ARTICLE");
    expect(inert).not.toHaveAttribute("tabindex");
    expect(inert).not.toHaveAttribute("aria-disabled");

    cleanup();
    render(<PortalCard vm={{
      item: { type: "service", host: "atlas", name: "static" },
      resolvedService: service("static"), status: "static",
      freshness: { ...fresh, state: "static", observedAt: null, ageMs: null, ttlMs: null },
    }} />);
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.getByText("static purpose")).toBeInTheDocument();
  });
});

describe("summary", () => {
  it("no longer renders a per-page health-header — the shell owns the region", () => {
    portalData = loaded();
    const { container } = render(<PortalPage />);
    expect(container.querySelector('[data-slot="health-header"]')).toBeNull();
  });

  it("renders the self-sufficient endpoint summary as a / link with icon + text", () => {
    portalData = loaded();
    render(<EndpointStatusSummary />);
    const link = screen.getByRole("link", { name: /1 up \/ 1 down/ });
    expect(link).toHaveAttribute("href", "/");
    expect(link.querySelector("svg.lucide-triangle-alert")).not.toBeNull();
  });

  it("derives mixed, all-down, all-up, and honest zero rich summaries", () => {
    expect(deriveEndpointSummary(loaded())).toMatchObject({
      label: "1 up / 1 down", status: "warning", count: 1, href: "/",
    });
    expect(deriveEndpointSummary(loaded({ gatus: { ...gatus, data: { endpoints: [
      { key: "a", up: false, latencyMs: null }, { key: "b", up: false, latencyMs: null },
    ] } } }))).toMatchObject({ label: "0 up / 2 down", status: "critical", count: 2 });
    expect(deriveEndpointSummary(loaded({ gatus: { ...gatus, data: { endpoints: [
      { key: "a", up: true, latencyMs: null },
    ] } } }))).toMatchObject({ label: "1 up / 0 down", status: "ok", count: 0 });
    expect(deriveEndpointSummary(loaded({ gatus: null })))
      .toMatchObject({ label: "No monitored endpoints", status: "ok", count: 0 });
    expect(deriveEndpointSummary(loaded({ gatus: { ...gatus, data: { endpoints: [] } } })))
      .toMatchObject({ label: "No monitored endpoints", status: "ok", count: 0 });
  });
});

describe("filters", () => {
  it("filters by search text, status and group, with a live result count and removable chips", async () => {
    const user = userEvent.setup();
    portalData = loaded();
    render(<PortalPage />);
    const count = screen.getByText(/^Showing/);
    expect(count).toHaveTextContent("Showing 10 of 10 items; 0 hidden by filters.");

    await user.type(screen.getByRole("searchbox", { name: "Search the portal" }), "subgroup");
    expect(cardTitles()).toEqual(["Subgroup Z", "Subgroup A"]);
    await user.clear(screen.getByRole("searchbox", { name: "Search the portal" }));

    const status = screen.getByRole("toolbar", { name: "Status" });
    await user.click(within(status).getByRole("button", { name: /^Down/ }));
    expect(cardTitles()).toEqual(["Down service"]);
    expect(count).toHaveTextContent("Showing 1 of 10 items; 9 hidden by filters.");

    await user.click(screen.getByRole("button", { name: "Remove status filter Down" }));
    const group = screen.getByRole("toolbar", { name: "Group" });
    await user.click(within(group).getByRole("button", { name: /^Last group/ }));
    expect(cardTitles()).toEqual(["Always visible link"]);
    expect(screen.getByRole("region", { name: "First group" })).toHaveTextContent("No visible items.");

    await user.click(screen.getByRole("button", { name: "Clear all" }));
    expect(cardTitles()).toHaveLength(10);
  }, 30_000); // userEvent typing is slow on a loaded host
});

describe("shared data and keyboard integration contracts", () => {
  it("renders cards from shared data without fetching on its own", async () => {
    // Polling and sharing live in the data layer (see data-layer.test.tsx); a card only renders.
    expect(await import("../src/features/portal/PortalCard.js?raw").then((module) => module.default)).not.toContain("fetch(");
  });

  it("drives search, filtering, navigation and opening through the keyboard", async () => {
    const user = userEvent.setup();
    portalData = loaded();
    render(<PortalPage />);
    // Record link activations instead of letting jsdom (not) navigate.
    const opened: string[] = [];
    const onClick = (event: MouseEvent): void => {
      const link = (event.target as Element).closest("a");
      if (link === null) return;
      event.preventDefault();
      opened.push(link.getAttribute("href") ?? "");
    };
    document.addEventListener("click", onClick);

    const search = screen.getByRole("searchbox", { name: "Search the portal" });
    await user.keyboard("/");
    expect(search).toHaveFocus();

    await user.keyboard("Up service");
    expect(cardTitles()).toEqual(["Up service"]);
    await user.keyboard("{Enter}");
    expect(opened).toEqual(["https://up.example"]);

    await user.keyboard("{Escape}");
    expect(search).toHaveValue("");
    expect(cardTitles()).toHaveLength(10);

    // Ctrl-K focuses the search field from anywhere.
    search.blur();
    await user.keyboard("{Control>}k{/Control}");
    expect(search).toHaveFocus();
    search.blur();

    // Only cards with a target are navigable; inert tiles are skipped.
    const links = cardLinks();
    expect(links.map((el) => el.textContent)).toEqual(
      expect.arrayContaining([expect.stringContaining("Subgroup Z")]),
    );
    expect(links).toHaveLength(5);
    await user.keyboard("{Home}");
    expect(links[0]).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(links[1]).toHaveFocus();
    await user.keyboard("j");
    expect(links[2]).toHaveFocus();
    await user.keyboard("l");
    expect(links[3]).toHaveFocus();
    await user.keyboard("h");
    expect(links[2]).toHaveFocus();
    await user.keyboard("{ArrowUp}");
    expect(links[1]).toHaveFocus();
    await user.keyboard("k");
    expect(links[0]).toHaveFocus();
    await user.keyboard("G");
    expect(links[4]).toHaveFocus();
    await user.keyboard("gg");
    expect(links[0]).toHaveFocus();

    await user.keyboard("{Enter}");
    expect(opened.at(-1)).toBe("https://z.example");

    document.removeEventListener("click", onClick);
  }, 30_000);
});

// Last in the file: these register into the shared registry singleton.
describe("slot host isolation (review L8)", () => {
  const Throws = (): never => {
    throw new Error("internal card failure must never reach the UI");
  };

  it("a throwing portal/summary widget leaves the portal heading, filters and cards intact", async () => {
    const { registerCard } = await import("../src/registry/registry.js");
    const { PORTAL_SUMMARY_SLOT } = await import("../src/shell/portal-summary-slot.js");
    registerCard({ id: "card:probe/throws", slot: PORTAL_SUMMARY_SLOT, component: Throws });
    portalData = loaded();
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(<PortalPage />);
    quiet.mockRestore();
    expect(screen.getByRole("heading", { level: 1, name: "Portal" })).toBeInTheDocument();
    expect(screen.getByRole("search", { name: "Portal filters" })).toBeInTheDocument();
    expect(cardTitles().length).toBeGreaterThan(0);
    expect(screen.getByRole("alert")).toHaveTextContent("Summary card unavailable");
    expect(document.body.textContent).not.toContain("internal card failure");
  });
});
