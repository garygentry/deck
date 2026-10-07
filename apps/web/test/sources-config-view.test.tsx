// @vitest-environment jsdom
//
// Configs-specific render coverage: the read-only FileViewer (highlighting, truncation, binary
// handling), the content-load gate for binary nodes, and the Configs page composition (verbatim
// notice with its session-scoped dismissal). The load hooks are mocked out and the singleton
// browse store is primed directly.

import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SourceTreeNode } from "@deck/server";

vi.mock("../src/features/sources-docs-and-configs/use-source.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useManifestLoad: () => {},
  useFileLoad: () => {},
  useSearchLoad: () => {},
}));

import { SourceBrowserReady } from "../src/features/sources-docs-and-configs/SourceBrowserPage.js";
import { fileLoadPath, findNode } from "../src/features/sources-docs-and-configs/links.js";
import { FileViewer } from "../src/features/sources-docs-and-configs/components/FileViewer.js";
import type { FileState } from "../src/features/sources-docs-and-configs/client.js";
import {
  resetBrowse,
  selectPath,
  selectSource,
  setFile,
  setManifest,
} from "../src/features/sources-docs-and-configs/sources-store.js";
import { dirNode, envelope, fileNode, manifest, sourcesConfig } from "./support/sources.js";

afterEach(() => {
  cleanup();
  act(() => resetBrowse());
  window.sessionStorage.clear();
});

function readyFile(result: {
  path: string;
  size?: number;
  truncated?: boolean;
  binary?: boolean;
  language?: string;
  content?: string;
}): FileState {
  return {
    status: "ready",
    result: {
      path: result.path,
      size: result.size ?? 16,
      truncated: result.truncated ?? false,
      binary: result.binary ?? false,
      language: result.language,
      content: result.content,
    },
  };
}

/** The code element of the rendered file figure (named by its caption, the file path). */
function codeOf(name: string): HTMLElement {
  const figure = screen.getByRole("figure", { name });
  const code = figure.querySelector("pre code");
  if (!(code instanceof HTMLElement)) throw new Error("no code element");
  return code;
}

describe("FileViewer highlighting", () => {
  it("highlights a known language (yaml) into highlight.js token markup", () => {
    render(
      <FileViewer
        node={fileNode("app.yaml")}
        file={readyFile({ path: "app.yaml", language: "yaml", content: "key: value\n" })}
      />,
    );
    const code = codeOf("app.yaml");
    expect(code.classList.contains("language-yaml")).toBe(true);
    // Token spans prove the highlighter actually ran.
    expect(code.querySelector("[class^='hljs-']")).not.toBeNull();
    expect(code.textContent).toBe("key: value\n");
    // The language is shown alongside the file name.
    expect(within(screen.getByRole("figure", { name: "app.yaml" })).getByText("yaml")).toBeTruthy();
  });

  it("resolves the language from the extension when the server hint is absent", () => {
    render(<FileViewer node={fileNode("app.yaml")} file={readyFile({ path: "app.yaml", content: "key: value\n" })} />);
    expect(codeOf("app.yaml").classList.contains("language-yaml")).toBe(true);
  });

  it("falls back to escaped plaintext for an unknown language without throwing", () => {
    render(
      <FileViewer
        node={fileNode("mystery.zzz")}
        file={readyFile({ path: "mystery.zzz", language: "totally-unknown-lang", content: "plain <b>text</b> & more" })}
      />,
    );
    const code = codeOf("mystery.zzz");
    expect([...code.classList].some((c) => c.startsWith("language-"))).toBe(false);
    // The source is text, never injected markup.
    expect(code.querySelector("b")).toBeNull();
    expect(code.textContent).toBe("plain <b>text</b> & more");
  });

  it("offers no editing affordance — only Copy (REQ-RO-01)", () => {
    render(<FileViewer node={fileNode("a.yaml")} file={readyFile({ path: "a.yaml", content: "a: 1" })} />);
    const names = screen.getAllByRole("button").map((b) => b.textContent ?? "");
    expect(names).toEqual([expect.stringMatching(/^Copy/)]);
  });
});

describe("FileViewer selection states", () => {
  it("prompts for a file, explains a folder, and announces loading or failure", () => {
    const { rerender } = render(<FileViewer node={null} file={{ status: "idle" }} />);
    expect(screen.getByRole("status").textContent).toContain("Select a file from the tree to view it.");

    rerender(<FileViewer node={dirNode("etc", [])} file={{ status: "idle" }} />);
    expect(screen.getByRole("status").textContent).toContain("This is a folder.");

    rerender(<FileViewer node={fileNode("a.yaml")} file={{ status: "loading", path: "a.yaml" }} />);
    expect(screen.getByRole("status", { name: "Loading file…" })).toBeTruthy();

    rerender(
      <FileViewer
        node={fileNode("a.yaml")}
        file={{ status: "error", path: "a.yaml", error: { message: "denied", code: "FORBIDDEN" } }}
      />,
    );
    const alert = screen.getByRole("alert");
    expect(within(alert).getByText("This file could not be read")).toBeTruthy();
    expect(within(alert).getByText("denied")).toBeTruthy();
  });
});

describe("FileViewer truncation (REQ-CFG-03)", () => {
  it("renders the truncation notice and no file body", () => {
    render(
      <FileViewer
        node={fileNode("huge.log")}
        file={readyFile({ path: "huge.log", size: 2 * 1024 * 1024, truncated: true })}
      />,
    );
    const notice = screen.getByRole("status", { name: "huge.log is too large" });
    expect(notice.textContent).toContain("too large to display (2.0 MiB)");
    expect(screen.queryByRole("figure")).toBeNull();
  });
});

describe("FileViewer binary handling (REQ-CFG-04)", () => {
  it("renders the binary placeholder from the manifest flag without a loaded body", () => {
    render(<FileViewer node={fileNode("logo.png", true)} file={{ status: "idle" }} />);
    expect(screen.getByRole("status").textContent).toContain("logo.png is a binary file — not shown.");
    expect(screen.queryByRole("figure")).toBeNull();
  });

  it("renders the placeholder when the server flags a result binary defensively", () => {
    render(<FileViewer node={fileNode("data.bin")} file={readyFile({ path: "data.bin", binary: true })} />);
    expect(screen.getByRole("status").textContent).toContain("binary file");
    expect(screen.queryByRole("figure")).toBeNull();
  });

  it("fileLoadPath returns null for a binary node so no content route is requested", () => {
    const binary = fileNode("logo.png", true);
    const text = fileNode("app.yaml");
    const dir: SourceTreeNode = dirNode("sub", []);

    expect(fileLoadPath(binary, "logo.png")).toBeNull();
    expect(fileLoadPath(text, "app.yaml")).toBe("app.yaml");
    expect(fileLoadPath(dir, "sub")).toBeNull();
    expect(fileLoadPath(null, "logo.png")).toBeNull();
    expect(fileLoadPath(text, null)).toBeNull();
  });

  it("findNode looks nodes up by path, depth-first", () => {
    const root = dirNode("", [dirNode("etc", [fileNode("etc/a.conf")])]);
    expect(findNode(root, "etc/a.conf")?.name).toBe("a.conf");
    expect(findNode(root, "missing")).toBeNull();
  });
});

describe("Configs page", () => {
  function primeConfigs(): void {
    selectSource("cfg");
    setManifest("cfg", {
      status: "ready",
      envelope: envelope("cfg", "file-tree", manifest("cfg", "file-tree", [fileNode("app.yaml")])),
    });
  }

  it("renders the verbatim notice, the tree, the freshness badge and the selected file", () => {
    primeConfigs();
    selectPath("app.yaml");
    setFile(readyFile({ path: "app.yaml", language: "yaml", content: "key: value\n" }));

    render(<SourceBrowserReady kind="configs" config={sourcesConfig("file-tree", "cfg")} />);

    const notice = screen.getByRole("note", { name: "Security notice" });
    expect(notice.textContent).toContain("verbatim");
    expect(screen.getByRole("tree", { name: "Files" })).toBeTruthy();
    expect(screen.getByText("Fresh")).toBeTruthy();
    expect(screen.getByRole("searchbox", { name: "Search this source" })).toBeTruthy();
    expect(codeOf("app.yaml").classList.contains("language-yaml")).toBe(true);
  });

  it("dismisses the verbatim notice for the session", async () => {
    primeConfigs();
    const { unmount } = render(
      <SourceBrowserReady kind="configs" config={sourcesConfig("file-tree", "cfg")} />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Dismiss security notice" }));
    expect(screen.queryByRole("note", { name: "Security notice" })).toBeNull();
    expect(window.sessionStorage.getItem("deck.sources.verbatimNotice.dismissed.configs")).toBe("1");
    unmount();

    // Remembered on the next mount within the session.
    render(<SourceBrowserReady kind="configs" config={sourcesConfig("file-tree", "cfg")} />);
    expect(screen.queryByRole("note", { name: "Security notice" })).toBeNull();
  });
});
