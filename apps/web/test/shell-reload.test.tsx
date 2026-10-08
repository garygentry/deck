// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { UiFinding, UiManifest } from "@deck/module-sdk";
import { primary } from "@deck/schema/fixtures";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { UI_MANIFEST_REFRESH_MS } from "../src/data/index.js";
import { resetQueryClient } from "../src/data/query-client.js";
import { reloadFindings } from "../src/shell/ReloadNotice.js";

/**
 * `ui` hot reload in the shell: the manifest is read again on focus and on an interval, so a
 * swapped nav shows without a page load, and the server's reload findings show in a Callout.
 */
const TEST_FILE_URL = import.meta.url;
const golden = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../server/test/golden/ui/examples-estate.json", TEST_FILE_URL)), "utf8"),
) as UiManifest;

const INVALID: UiFinding = {
  code: "UI_CONFIG_INVALID",
  severity: "warning",
  message: "The config changed but does not load, so deck still serves the last good config: bad indentation",
};

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetQueryClient();
});

/** Render the app with `/api/ui` answered by `serve()` on each read; returns the read count. */
async function renderApp(serve: () => UiManifest): Promise<() => number> {
  vi.resetModules();
  let reads = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url === "/api/config") return Response.json(primary.merged);
    if (url === "/api/ui") {
      reads += 1;
      return Response.json(serve());
    }
    return new Response(null, { status: 404 });
  }));
  vi.stubGlobal("location", new URL("http://localhost/hosts"));
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false, media: query, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  }));
  await import("../src/shell/health-header/slot.js");
  await import("../src/registry/discover.js");
  const { App } = await import("../src/shell/App.js");
  render(<App />);
  return () => reads;
}

const sidebarLinks = () => within(screen.getByRole("navigation", { name: "Primary" })).queryAllByRole("link").map((link) => link.textContent);

describe("ui hot reload in the shell", () => {
  it("re-reads the manifest when the window regains focus and shows the new nav", async () => {
    let served = golden;
    const reads = await renderApp(() => served);
    await waitFor(() => expect(sidebarLinks()).toContain("Services"));
    expect(reads()).toBe(1);

    served = { ...golden, nav: golden.nav.filter((item) => item.id !== "nav:inventory/services") };
    await act(async () => {
      window.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() => expect(sidebarLinks()).not.toContain("Services"));
    expect(reads()).toBe(2);
    expect(sidebarLinks()).toContain("Hosts");
  });

  it("re-reads the manifest every refresh interval", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let served = golden;
    const reads = await renderApp(() => served);
    await waitFor(() => expect(sidebarLinks()).toContain("Services"));

    served = { ...golden, findings: [INVALID] };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(UI_MANIFEST_REFRESH_MS);
    });
    await waitFor(() => expect(reads()).toBe(2));
    await waitFor(() => expect(screen.getByText("Config change not applied")).toBeInTheDocument());
  });

  it("shows the reload findings in a Callout, and keeps the last good nav", async () => {
    const reads = await renderApp(() => ({ ...golden, findings: [INVALID] }));
    const notice = (await screen.findByText("Config change not applied")).closest('[data-slot="callout"]');
    expect(notice).toHaveAttribute("role", "status");
    expect(notice).toHaveAttribute("data-tone", "warn");
    expect(notice).toHaveTextContent("bad indentation");
    expect(sidebarLinks()).toContain("Services");
    expect(reads()).toBe(1);
  });

  it("titles a restart-required finding as such", async () => {
    await renderApp(() => ({
      ...golden,
      findings: [{ code: "UI_RESTART_REQUIRED", severity: "warning", message: "The config changed outside ui (integrations): restart deck to apply it." }],
    }));
    expect(await screen.findByText("Restart deck to apply the config change")).toBeInTheDocument();
    expect(screen.getByText(/outside ui \(integrations\)/)).toBeInTheDocument();
  });
});

describe("reloadFindings", () => {
  const ready = (findings: unknown[]) => ({ status: "ready" as const, manifest: { ...golden, findings: findings as UiFinding[] } });

  it("keeps only well-formed reload findings", () => {
    const resolveFinding: UiFinding = { code: "UI_UNKNOWN_EXTENSION", severity: "warning", message: "x", id: "pill:x/y" };
    expect(reloadFindings(ready([resolveFinding, INVALID, { code: "UI_RESTART_REQUIRED", message: 3 }, null]))).toEqual([INVALID]);
    expect(reloadFindings({ status: "loading" })).toEqual([]);
    expect(reloadFindings({ status: "error", message: "down" })).toEqual([]);
  });
});
