// @vitest-environment jsdom
//
// State-distinctness matrix for the source browser, run identically for Docs and Configs so the
// two kinds of the one page component never drift. The load hooks are mocked out and the
// singleton browse store is primed directly, so each envelope state renders deterministically:
//
//   | envelope                                   | expected render                                  |
//   | fileCount > 0                              | tree + content pane                              |
//   | fileCount === 0                            | accessible "nothing to show" empty (role=status) |
//   | data:null + error set                      | explicit error state (role=alert)                |
//   | last-good manifest + freshness "stale"     | last-good tree PLUS a stale freshness badge      |
//
// Plus the config ladder, the source switcher (a radio group, present iff > 1 source), the
// render-failure boundary, and the sidebar's filter keys.

import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SourceKind } from "@deck/server";

vi.mock("../src/features/sources-docs-and-configs/use-source.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useManifestLoad: () => {},
  useFileLoad: () => {},
  useSearchLoad: () => {},
}));

import {
  SourceBrowserReady,
  SourceBrowserView,
  type SourceBrowserKind,
} from "../src/features/sources-docs-and-configs/SourceBrowserPage.js";
import {
  getSourceBrowse,
  resetBrowse,
  selectSource,
  setFilter,
  setManifest,
} from "../src/features/sources-docs-and-configs/sources-store.js";
import { dirNode, envelope, fileNode, manifest, sourcesConfig } from "./support/sources.js";

afterEach(() => {
  cleanup();
  act(() => resetBrowse());
  window.history.replaceState(null, "", "/");
  window.sessionStorage.clear();
});

const PAGES: ReadonlyArray<{
  label: string;
  kind: SourceBrowserKind;
  sourceKind: SourceKind;
  emptyText: string;
  noSourcesText: string;
  loadingText: string;
}> = [
  {
    label: "Docs",
    kind: "docs",
    sourceKind: "markdown-tree",
    emptyText: "No documents to show",
    noSourcesText: "No documentation sources are configured.",
    loadingText: "Loading docs…",
  },
  {
    label: "Configs",
    kind: "configs",
    sourceKind: "file-tree",
    emptyText: "Nothing to show",
    noSourcesText: "No config sources",
    loadingText: "Loading configs…",
  },
];

function prime(sourceKind: SourceKind, children = [fileNode("a.md")], state: "fresh" | "stale" = "fresh"): void {
  selectSource("s1");
  setManifest("s1", {
    status: "ready",
    envelope: envelope("s1", sourceKind, manifest("s1", sourceKind, children), state),
  });
}

for (const { label, kind, sourceKind, emptyText, noSourcesText, loadingText } of PAGES) {
  describe(`${label}: envelope states render distinctly`, () => {
    it("heads the page with a level-1 heading that labels the page section", () => {
      prime(sourceKind);
      render(<SourceBrowserReady kind={kind} config={sourcesConfig(sourceKind, "s1")} />);
      const heading = screen.getByRole("heading", { level: 1, name: label });
      expect(heading.id).toBe(`${kind}-heading`);
      expect(screen.getByRole("region", { name: label })).toBeTruthy();
    });

    it("fileCount > 0 → tree + content pane", () => {
      prime(sourceKind);
      render(<SourceBrowserReady kind={kind} config={sourcesConfig(sourceKind, "s1")} />);

      const tree = screen.getByRole("tree", { name: "Files" });
      expect(within(tree).getByRole("treeitem", { name: "a.md" })).toBeTruthy();
      expect(screen.queryByText(emptyText)).toBeNull();
      expect(screen.queryByRole("alert")).toBeNull();
    });

    it("fileCount === 0 → accessible empty state (role=status), never role=alert", () => {
      prime(sourceKind, []);
      render(<SourceBrowserReady kind={kind} config={sourcesConfig(sourceKind, "s1")} />);

      expect(screen.getByRole("status")).toHaveProperty("textContent", expect.stringContaining(emptyText));
      expect(screen.queryByRole("tree")).toBeNull();
      expect(screen.queryByRole("alert")).toBeNull();
    });

    it("data:null + error set → explicit error state (role=alert) with Retry", () => {
      selectSource("s1");
      setManifest("s1", {
        status: "ready",
        envelope: envelope("s1", sourceKind, null, "unreachable", { message: "the source is unreachable" }),
      });
      render(<SourceBrowserReady kind={kind} config={sourcesConfig(sourceKind, "s1")} />);

      const alert = screen.getByRole("alert");
      expect(within(alert).getByText("This source could not be loaded")).toBeTruthy();
      expect(within(alert).getByText("the source is unreachable")).toBeTruthy();
      expect(within(alert).getByRole("button", { name: "Retry" })).toBeTruthy();
      expect(screen.queryByText(emptyText)).toBeNull();
      expect(screen.queryByRole("tree")).toBeNull();
      // The freshness badge still stamps the failure (icon + text).
      expect(screen.getByText("Unreachable")).toBeTruthy();
    });

    it("a transport failure is an error state too", () => {
      selectSource("s1");
      setManifest("s1", { status: "error", error: { message: "request failed", code: "REQUEST" } });
      render(<SourceBrowserReady kind={kind} config={sourcesConfig(sourceKind, "s1")} />);
      expect(within(screen.getByRole("alert")).getByText("request failed")).toBeTruthy();
    });

    it("Retry re-selects the source (back to loading)", async () => {
      selectSource("s1");
      setManifest("s1", { status: "error", error: { message: "request failed", code: "REQUEST" } });
      render(<SourceBrowserReady kind={kind} config={sourcesConfig(sourceKind, "s1")} />);

      await userEvent.click(screen.getByRole("button", { name: "Retry" }));
      expect(getSourceBrowse().manifest.status).toBe("loading");
      expect(screen.getByRole("status", { name: "Loading source…" })).toBeTruthy();
    });

    it("last-good manifest + freshness 'stale' → last-good tree PLUS a stale badge", () => {
      prime(sourceKind, [fileNode("a.md")], "stale");
      render(<SourceBrowserReady kind={kind} config={sourcesConfig(sourceKind, "s1")} />);

      expect(screen.getByRole("treeitem", { name: "a.md" })).toBeTruthy();
      // Staleness by icon + text, never colour alone.
      const badge = screen.getByText("Stale").closest("[data-slot=freshness-badge]");
      expect(badge?.querySelector("svg[aria-hidden='true']")).not.toBeNull();
    });

    it("no source of the kind declared → its own empty state", () => {
      render(<SourceBrowserReady kind={kind} config={sourcesConfig(sourceKind)} />);
      expect(screen.getByRole("status")).toHaveProperty(
        "textContent",
        expect.stringContaining(noSourcesText),
      );
      expect(screen.queryByRole("tree")).toBeNull();
    });

    it("config ladder: loading keeps the heading and announces the page load", () => {
      render(<SourceBrowserView kind={kind} state={{ status: "loading" }} />);
      expect(screen.getByRole("heading", { level: 1, name: label })).toBeTruthy();
      expect(screen.getByRole("status", { name: loadingText })).toBeTruthy();
    });

    it("config ladder: a config failure is an alert under the heading", () => {
      render(<SourceBrowserView kind={kind} state={{ status: "error", message: "GET /api/config → 500" }} />);
      expect(screen.getByRole("heading", { level: 1, name: label })).toBeTruthy();
      const alert = screen.getByRole("alert");
      expect(within(alert).getByText("Failed to load configuration")).toBeTruthy();
      expect(within(alert).getByText("GET /api/config → 500")).toBeTruthy();
    });
  });

  describe(`${label}: source switcher`, () => {
    it("is absent with a single source of the kind", () => {
      prime(sourceKind);
      render(<SourceBrowserReady kind={kind} config={sourcesConfig(sourceKind, "s1")} />);
      expect(screen.queryByRole("radiogroup", { name: "Source" })).toBeNull();
    });

    it("is a radio group with the active source checked when > 1 source is declared", () => {
      prime(sourceKind);
      render(<SourceBrowserReady kind={kind} config={sourcesConfig(sourceKind, "s1", "s2")} />);

      const group = screen.getByRole("radiogroup", { name: "Source" });
      const radios = within(group).getAllByRole("radio");
      expect(radios.map((r) => r.textContent)).toEqual(["Source s1", "Source s2"]);
      expect(within(group).getByRole("radio", { name: "Source s1" }).getAttribute("aria-checked")).toBe("true");
      expect(within(group).getByRole("radio", { name: "Source s2" }).getAttribute("aria-checked")).toBe("false");
    });

    it("switching selects the source in the store and in the URL", async () => {
      prime(sourceKind);
      render(<SourceBrowserReady kind={kind} config={sourcesConfig(sourceKind, "s1", "s2")} />);

      await userEvent.click(screen.getByRole("radio", { name: "Source s2" }));

      expect(getSourceBrowse().activeSourceId).toBe("s2");
      expect(window.location.pathname).toBe(`/${kind}`);
      expect(new URLSearchParams(window.location.search).get("source")).toBe("s2");
      expect(screen.getByRole("radio", { name: "Source s2" }).getAttribute("aria-checked")).toBe("true");
    });

    it("the URL ?source= picks the active source", () => {
      window.history.replaceState(null, "", `/${kind}?source=s2`);
      selectSource("s2");
      setManifest("s2", {
        status: "ready",
        envelope: envelope("s2", sourceKind, manifest("s2", sourceKind, [fileNode("b.md")])),
      });
      render(<SourceBrowserReady kind={kind} config={sourcesConfig(sourceKind, "s1", "s2")} />);

      expect(screen.getByRole("radio", { name: "Source s2" }).getAttribute("aria-checked")).toBe("true");
      expect(screen.getByRole("treeitem", { name: "b.md" })).toBeTruthy();
    });
  });

  describe(`${label}: tree filter`, () => {
    const children = [dirNode("etc", [fileNode("etc/site.conf"), fileNode("etc/app.yaml")]), fileNode("readme.md")];

    it("filters by path, keeps the ancestors of matches, and names a no-match", async () => {
      prime(sourceKind, children);
      render(<SourceBrowserReady kind={kind} config={sourcesConfig(sourceKind, "s1")} />);

      await userEvent.type(screen.getByRole("searchbox", { name: "Filter files" }), "site");
      expect(getSourceBrowse().filter).toBe("site");
      expect(screen.getByRole("treeitem", { name: "etc" }).getAttribute("aria-expanded")).toBe("true");
      expect(screen.getByRole("treeitem", { name: "site.conf" })).toBeTruthy();
      expect(screen.queryByRole("treeitem", { name: "app.yaml" })).toBeNull();
      expect(screen.queryByRole("treeitem", { name: "readme.md" })).toBeNull();

      // A folder name matches through its files' paths.
      act(() => setFilter("etc"));
      expect(screen.getByRole("treeitem", { name: "app.yaml" })).toBeTruthy();

      act(() => setFilter("zzz"));
      expect(screen.getByText("No files match ‘zzz’.").closest("[role=status]")).not.toBeNull();
      expect(screen.queryByRole("tree")).toBeNull();
    });

    it("'/' and Ctrl-K focus the filter; Escape from the tree clears it", async () => {
      prime(sourceKind, children);
      render(<SourceBrowserReady kind={kind} config={sourcesConfig(sourceKind, "s1")} />);
      const filter = screen.getByRole("searchbox", { name: "Filter files" });

      screen.getByRole("treeitem", { name: "readme.md" }).focus();
      await userEvent.keyboard("/");
      expect(document.activeElement).toBe(filter);

      screen.getByRole("treeitem", { name: "readme.md" }).focus();
      await userEvent.keyboard("{Control>}k{/Control}");
      expect(document.activeElement).toBe(filter);

      act(() => setFilter("read"));
      screen.getByRole("treeitem", { name: "readme.md" }).focus();
      await userEvent.keyboard("{Escape}");
      expect(getSourceBrowse().filter).toBe("");
    });

    it("activating a file selects it; a folder toggles", async () => {
      prime(sourceKind, children);
      render(<SourceBrowserReady kind={kind} config={sourcesConfig(sourceKind, "s1")} />);

      const folder = screen.getByRole("treeitem", { name: "etc" });
      expect(folder.getAttribute("aria-expanded")).toBe("false");
      folder.focus();
      await userEvent.keyboard("{ArrowRight}");
      expect(folder.getAttribute("aria-expanded")).toBe("true");

      await userEvent.click(screen.getByText("app.yaml"));
      expect(getSourceBrowse().selectedPath).toBe("etc/app.yaml");
      expect(screen.getByRole("treeitem", { name: "app.yaml" }).getAttribute("aria-current")).toBe("true");
    });
  });
}

describe("render-failure isolation", () => {
  it("a throw in the page renders the page's own failure heading + Retry", async () => {
    const { SourceBrowserPage } = await import(
      "../src/features/sources-docs-and-configs/SourceBrowserPage.js"
    );
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    // An invalid store state (a ready manifest whose tree is missing) makes the page throw.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify(sourcesConfig("file-tree", "s1")), {
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    selectSource("s1");
    setManifest("s1", {
      status: "ready",
      envelope: {
        ...envelope("s1", "file-tree", manifest("s1", "file-tree", [fileNode("a")])),
        data: { fileCount: 1 } as never,
      },
    });
    render(<SourceBrowserPage kind="configs" />);

    expect(
      await screen.findByRole("heading", { level: 1, name: "Configs view could not be displayed" }),
    ).toBeTruthy();
    expect(screen.getByText("This display failed independently of the server.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry configs view" })).toBeTruthy();
    vi.unstubAllGlobals();
    error.mockRestore();
  });
});
