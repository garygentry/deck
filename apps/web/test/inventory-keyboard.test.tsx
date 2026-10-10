// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { JSX } from "react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { InventoryData } from "../../../modules/inventory/web/use-inventory-data.js";
import {
  availableState,
  config,
  hostDecl,
  hostState,
  makeData,
  observedHost,
  observedService,
  serviceDecl,
  snapshotResult,
} from "./inventory-harness.js";

// The mocked context drives the lists without polling (the real store never runs).
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

import { HostsPage } from "../../../modules/inventory/web/hosts/list.js";
import { ServicesPage } from "../../../modules/inventory/web/services/list.js";

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

// Record link activations (and keep jsdom from attempting a navigation).
let clicks: string[] = [];
const recordClick = (event: MouseEvent): void => {
  const link = (event.target as Element | null)?.closest?.("a[href]");
  if (link === null || link === undefined) return;
  clicks.push(link.getAttribute("href")!);
  event.preventDefault();
};
beforeEach(() => {
  clicks = [];
  document.addEventListener("click", recordClick, true);
});
afterEach(() => {
  document.removeEventListener("click", recordClick, true);
  cleanup();
  vi.restoreAllMocks();
});

const threeHosts = (hidden = false): InventoryData =>
  makeData({
    config: config([hostDecl("alpha"), hostDecl("bravo"), hostDecl("charlie", { hidden })]),
    snapshot: availableState(
      snapshotResult({
        hosts: [observedHost("alpha"), observedHost("bravo"), observedHost("charlie")],
        hostStates: {
          alpha: hostState("fresh"),
          bravo: hostState("fresh"),
          charlie: hostState("fresh"),
        },
      }),
    ),
  });

const threeServices = (hidden = false): InventoryData =>
  makeData({
    config: config(
      [hostDecl("alpha"), hostDecl("bravo"), hostDecl("charlie")],
      [serviceDecl("alpha", "api"), serviceDecl("bravo", "db"), serviceDecl("charlie", "web", { hidden })],
    ),
    snapshot: availableState(
      snapshotResult({
        hosts: [observedHost("alpha"), observedHost("bravo"), observedHost("charlie")],
        services: [
          observedService("alpha", "api"),
          observedService("bravo", "db"),
          observedService("charlie", "web"),
        ],
        hostStates: {
          alpha: hostState("fresh"),
          bravo: hostState("fresh"),
          charlie: hostState("fresh"),
        },
      }),
    ),
  });

interface ListCase {
  label: string;
  Page: () => JSX.Element;
  data: (hidden?: boolean) => InventoryData;
  searchName: string;
  firstFacet: string;
  excludeName: string;
  query: string;
  hrefs: readonly [string, string, string];
}

const CASES: readonly ListCase[] = [
  {
    label: "Hosts",
    Page: HostsPage,
    data: threeHosts,
    searchName: "Search hosts",
    firstFacet: "Kind",
    excludeName: "Exclude hidden hosts",
    query: "alpha",
    hrefs: ["/hosts/alpha", "/hosts/bravo", "/hosts/charlie"],
  },
  {
    label: "Services",
    Page: ServicesPage,
    data: threeServices,
    searchName: "Search services",
    firstFacet: "Host",
    excludeName: "Exclude hidden services",
    query: "api",
    hrefs: ["/services/alpha/api", "/services/bravo/db", "/services/charlie/web"],
  },
];

/** The href of the focused element, if it is a link. */
function activeHref(): string | null {
  return document.activeElement?.getAttribute("href") ?? null;
}

/** The row links, in DOM order. */
function rowLinks(): HTMLElement[] {
  return within(screen.getByRole("table"))
    .getAllByRole("rowheader")
    .map((cell) => within(cell).getByRole("link"));
}

for (const list of CASES) {
  describe(`${list.label} list keyboard`, () => {
    const search = () => screen.getByRole("searchbox", { name: list.searchName });

    it("focuses search with /, filters, and Escape clears back to a row", async () => {
      const user = userEvent.setup();
      inventoryData = list.data();
      render(<list.Page />);

      await user.keyboard("/");
      expect(search()).toHaveFocus();
      // The `/` itself is not typed.
      expect(search()).toHaveValue("");

      await user.keyboard(list.query);
      expect(rowLinks()).toHaveLength(1);

      await user.keyboard("{Escape}");
      expect(search()).toHaveValue("");
      expect(rowLinks()).toHaveLength(3);
      expect(activeHref()).toBe(list.hrefs[0]);
    });

    it("focuses search with Ctrl-K and Cmd-K from a row", async () => {
      const user = userEvent.setup();
      inventoryData = list.data();
      render(<list.Page />);

      await user.keyboard("j");
      expect(activeHref()).toBe(list.hrefs[0]);
      await user.keyboard("{Control>}k{/Control}");
      expect(search()).toHaveFocus();
      rowLinks()[1]!.focus();
      await user.keyboard("{Meta>}K{/Meta}");
      expect(search()).toHaveFocus();
    });

    it("moves between rows with arrows, j/k, Home/End and gg/G, clamped", async () => {
      const user = userEvent.setup();
      inventoryData = list.data();
      render(<list.Page />);
      const [first, second, last] = list.hrefs;

      await user.keyboard("{ArrowDown}");
      expect(activeHref()).toBe(first);
      await user.keyboard("j");
      expect(activeHref()).toBe(second);
      await user.keyboard("k");
      expect(activeHref()).toBe(first);
      await user.keyboard("{ArrowUp}");
      expect(activeHref()).toBe(first);
      await user.keyboard("{End}");
      expect(activeHref()).toBe(last);
      await user.keyboard("j");
      expect(activeHref()).toBe(last);
      await user.keyboard("{Home}");
      expect(activeHref()).toBe(first);
      await user.keyboard("G");
      expect(activeHref()).toBe(last);
      await user.keyboard("gg");
      expect(activeHref()).toBe(first);
    });

    it("opens the focused row on Enter, and the first row on Enter from search", async () => {
      const user = userEvent.setup();
      inventoryData = list.data();
      render(<list.Page />);

      await user.keyboard("{End}{Enter}");
      expect(clicks.at(-1)).toBe(list.hrefs[2]);

      await user.keyboard("/{Enter}");
      expect(clicks.at(-1)).toBe(list.hrefs[0]);
      // Each Enter activates exactly once.
      expect(clicks).toHaveLength(2);
    });

    it("recovers focus onto the first row when a filter removes the focused row", async () => {
      const user = userEvent.setup();
      inventoryData = list.data(true);
      render(<list.Page />);

      await user.keyboard("{End}");
      expect(activeHref()).toBe(list.hrefs[2]);
      // The focused (hidden) row disappears while it still holds focus.
      const exclude = screen.getByRole("checkbox", { name: list.excludeName });
      fireEvent.click(exclude);
      expect(exclude).toBeChecked();
      expect(rowLinks()).toHaveLength(2);
      expect(activeHref()).toBe(list.hrefs[0]);
    });

    it("leaves focus on a filter control the user is operating", async () => {
      const user = userEvent.setup();
      inventoryData = list.data(true);
      render(<list.Page />);

      await user.keyboard("{End}");
      // Operate exclude-hidden by keyboard: the last (hidden) row disappears,
      // but focus was moved on purpose, so it stays on the checkbox.
      const exclude = screen.getByRole("checkbox", { name: list.excludeName });
      exclude.focus();
      await user.keyboard(" ");
      expect(exclude).toBeChecked();
      expect(rowLinks()).toHaveLength(2);
      expect(exclude).toHaveFocus();
    });

    it("never takes focus from search while the user types", async () => {
      const user = userEvent.setup();
      inventoryData = list.data();
      render(<list.Page />);

      await user.keyboard("{End}/");
      await user.keyboard(list.query);
      expect(rowLinks()).toHaveLength(1);
      expect(search()).toHaveFocus();
    });

    it("stands aside for keys inside other controls, and never consumes Tab", async () => {
      const user = userEvent.setup();
      inventoryData = list.data();
      render(<list.Page />);

      await user.keyboard("j");
      expect(activeHref()).toBe(list.hrefs[0]);

      const exclude = screen.getByRole("checkbox", { name: list.excludeName });
      expect(fireEvent.keyDown(exclude, { key: "ArrowDown" })).toBe(true);
      expect(activeHref()).toBe(list.hrefs[0]);

      expect(fireEvent.keyDown(rowLinks()[0]!, { key: "Tab" })).toBe(true);
      // Tab from search reaches the first facet control, then back.
      search().focus();
      await user.tab();
      expect(screen.getByRole("button", { name: new RegExp(`^${list.firstFacet}`) })).toHaveFocus();
      await user.tab({ shift: true });
      expect(search()).toHaveFocus();
    });

    it("keeps keys typed inside an open facet popover away from the rows", async () => {
      const user = userEvent.setup();
      inventoryData = list.data();
      render(<list.Page />);

      await user.click(screen.getByRole("button", { name: new RegExp(`^${list.firstFacet}`) }));
      const listbox = await screen.findByRole("listbox");
      await user.keyboard("j");
      expect(activeHref()).toBeNull();
      expect(listbox).toBeInTheDocument();
    });

    it("registers one window keydown listener and removes it on unmount", () => {
      const add = vi.spyOn(window, "addEventListener");
      const remove = vi.spyOn(window, "removeEventListener");
      inventoryData = list.data();
      const { unmount } = render(<list.Page />);
      const added = add.mock.calls.filter(([type]) => type === "keydown");
      expect(added).toHaveLength(1);
      unmount();
      const removed = remove.mock.calls.filter(([type]) => type === "keydown");
      expect(removed.map(([, listener]) => listener)).toContain(added[0]![1]);
    });

    it("treats movement and open as no-ops over an empty table", async () => {
      const user = userEvent.setup();
      inventoryData = makeData({ config: config([]), snapshot: availableState(snapshotResult()) });
      render(<list.Page />);

      await user.keyboard("j");
      expect(document.activeElement).toBe(document.body);
      await user.keyboard("{Enter}");
      expect(clicks).toHaveLength(0);
    });
  });
}
