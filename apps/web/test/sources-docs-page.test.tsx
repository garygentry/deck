// @vitest-environment jsdom
//
// Docs-specific render coverage: the selected markdown document (through the sanitized markdown
// pipeline into `Prose`), the document-pane states, and the content-search results. The load
// hooks are mocked out and the singleton browse store is primed directly. jsdom is required:
// renderMarkdown → DOMPurify needs a DOM.

import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../modules/sources/web/use-source.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useManifestLoad: () => {},
  useFileLoad: () => {},
  useSearchLoad: () => {},
}));

import { SourceBrowserReady } from "../../../modules/sources/web/SourceBrowserPage.js";
import { MarkdownView } from "../../../modules/sources/web/components/MarkdownView.js";
import { SearchResults } from "../../../modules/sources/web/components/SearchResults.js";
import {
  getSourceBrowse,
  resetBrowse,
  selectPath,
  selectSource,
  setFile,
  setManifest,
  setSearch,
} from "../../../modules/sources/web/sources-store.js";
import { envelope, fileNode, manifest, sourcesConfig } from "./support/sources.js";

afterEach(() => {
  cleanup();
  act(() => resetBrowse());
});

function primeDocs(): void {
  selectSource("docs");
  setManifest("docs", {
    status: "ready",
    envelope: envelope("docs", "markdown-tree", manifest("docs", "markdown-tree", [fileNode("intro.md")])),
  });
}

describe("Docs page", () => {
  it("renders the tree, the freshness badge and the selected document", () => {
    primeDocs();
    selectPath("intro.md");
    setFile({
      status: "ready",
      result: { path: "intro.md", size: 16, truncated: false, binary: false, content: "# Hello\n\nWorld" },
    });

    render(<SourceBrowserReady kind="docs" config={sourcesConfig("markdown-tree", "docs")} />);

    expect(screen.getByRole("treeitem", { name: "intro.md" }).getAttribute("aria-current")).toBe("true");
    const article = screen.getByRole("article", { name: "Document" });
    expect(within(article).getByRole("heading", { level: 1, name: "Hello" })).toBeTruthy();
    expect(within(article).getByText("World")).toBeTruthy();
    // Docs shows no verbatim notice and, with one source, no switcher.
    expect(screen.queryByRole("note", { name: "Security notice" })).toBeNull();
    expect(screen.queryByRole("radiogroup", { name: "Source" })).toBeNull();
    // Freshness from the active envelope (icon + text).
    expect(screen.getByText("Fresh")).toBeTruthy();
    // Only the page heading is a level-1 heading besides the document's own.
    expect(screen.getByRole("heading", { level: 1, name: "Docs" })).toBeTruthy();
  });

  it("labels the content search and opens a result in place", async () => {
    primeDocs();
    setSearch({
      status: "ready",
      result: {
        sourceId: "docs",
        matches: [
          { path: "intro.md", kind: "content", line: 3, snippet: "the needle here" },
          { path: "guide/needle.md", kind: "name" },
        ],
      },
    });

    render(<SourceBrowserReady kind="docs" config={sourcesConfig("markdown-tree", "docs")} />);

    expect(screen.getByRole("searchbox", { name: "Search document contents" })).toBeTruthy();
    const results = screen.getByRole("list", { name: "Search results" });
    const rows = within(results).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByText("the needle here")).toBeTruthy();

    await userEvent.click(within(results).getByRole("button", { name: /intro\.md:3/ }));
    expect(getSourceBrowse().selectedPath).toBe("intro.md");
  });
});

describe("MarkdownView states", () => {
  it("prompts for a document when nothing is selected", () => {
    render(<MarkdownView sourceId="docs" file={{ status: "idle" }} selectedPath={null} />);
    expect(within(screen.getByRole("status")).getByText("Select a document to read.")).toBeTruthy();
  });

  it("announces loading", () => {
    render(<MarkdownView sourceId="docs" file={{ status: "loading", path: "a.md" }} selectedPath="a.md" />);
    expect(screen.getByRole("status", { name: "Loading document…" })).toBeTruthy();
  });

  it("shows a read failure as an alert with the safe message", () => {
    render(
      <MarkdownView
        sourceId="docs"
        file={{ status: "error", path: "a.md", error: { message: "not found", code: "NOT_FOUND" } }}
        selectedPath="a.md"
      />,
    );
    expect(within(screen.getByRole("alert")).getByText("not found")).toBeTruthy();
  });

  it("reports an oversized or binary document instead of rendering it", () => {
    const { unmount } = render(
      <MarkdownView
        sourceId="docs"
        file={{ status: "ready", result: { path: "big.md", size: 2_000_000, truncated: true, binary: false } }}
        selectedPath="big.md"
      />,
    );
    expect(screen.getByRole("status").textContent).toContain("too large to display (2000000 bytes)");
    expect(screen.queryByRole("article")).toBeNull();
    unmount();

    render(
      <MarkdownView
        sourceId="docs"
        file={{ status: "ready", result: { path: "x.md", size: 4, truncated: false, binary: true } }}
        selectedPath="x.md"
      />,
    );
    expect(screen.getByRole("status").textContent).toContain("not a text document");
  });

  it("sanitizes the document (the pipeline is the XSS boundary)", () => {
    render(
      <MarkdownView
        sourceId="docs"
        file={{
          status: "ready",
          result: {
            path: "x.md",
            size: 4,
            truncated: false,
            binary: false,
            content: '<img src="x" onerror="alert(1)"><script>alert(2)</script>ok',
          },
        }}
        selectedPath="x.md"
      />,
    );
    const article = screen.getByRole("article", { name: "Document" });
    expect(article.querySelector("script")).toBeNull();
    expect(article.querySelector("[onerror]")).toBeNull();
  });
});

describe("SearchResults states", () => {
  it("renders nothing while idle", () => {
    const { container } = render(<SearchResults search={{ status: "idle" }} query="" onOpen={() => {}} />);
    expect(container.textContent).toBe("");
  });

  it("announces searching, no matches, a failure and a truncated result set", () => {
    const { rerender } = render(
      <SearchResults search={{ status: "loading", query: "x" }} query="x" onOpen={() => {}} />,
    );
    expect(screen.getByRole("status", { name: "Searching…" })).toBeTruthy();

    rerender(
      <SearchResults
        search={{ status: "ready", result: { sourceId: "s", matches: [] } }}
        query="x"
        onOpen={() => {}}
      />,
    );
    expect(screen.getByRole("status").textContent).toContain("No matches for ‘x’.");

    rerender(
      <SearchResults
        search={{ status: "error", query: "x", error: { message: "search broke", code: "REQUEST" } }}
        query="x"
        onOpen={() => {}}
      />,
    );
    expect(within(screen.getByRole("alert")).getByText("search broke")).toBeTruthy();

    rerender(
      <SearchResults
        search={{
          status: "ready",
          result: { sourceId: "s", matches: [{ path: "a", kind: "name" }], truncated: true },
        }}
        query="x"
        onOpen={() => {}}
      />,
    );
    expect(screen.getByRole("status").textContent).toContain("Showing the first 200 matches");
  });
});
