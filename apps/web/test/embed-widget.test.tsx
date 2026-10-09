// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { UiManifest, UiWidgetInstance } from "@deck/module-sdk";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { resetQueryClient } from "../src/data/query-client.js";
import { EmbedWidget, embedTarget, sandboxOf, type EmbedOptions } from "../src/features/core-widgets/EmbedWidget.js";

/**
 * `core/embed` against its gate and its frame: it frames nothing unless the UI manifest says
 * the config allows embeds, waits for the manifest and stays off when it cannot be read; the
 * frame is always sandboxed (default scripts + own origin, a widget's tokens replacing them,
 * never one outside the schema's list), sends no referrer, and never shows deck's own origin.
 */

// Through a variable: Vite rewrites `new URL("…", import.meta.url)` written inline as an asset.
const TEST_FILE_URL = import.meta.url;
const golden = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../server/test/golden/ui/examples-estate.json", TEST_FILE_URL)), "utf8"),
) as UiManifest;

const URL_ = "https://grafana.example.net/d/ups?kiosk";

function widget(title: string | null): UiWidgetInstance {
  return { id: "widget:ui/lab.graph", type: "core/embed", ...(title === null ? {} : { title }), source: null, options: {}, span: 1, rows: 1 };
}

/** Serve /api/ui as `ui` (a manifest, an HTTP status, or never), then render the widget (`null`: untitled). */
function show(ui: UiManifest | number | "never", options: Partial<EmbedOptions> = {}, title: string | null = "UPS graph") {
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
    if (String(input) !== "/api/ui") return new Response(null, { status: 404 });
    if (ui === "never") return new Promise<Response>(() => undefined);
    return typeof ui === "number" ? new Response(null, { status: ui }) : Response.json(ui);
  }));
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  return render(<EmbedWidget value={null} options={{ url: URL_, ...options }} freshness={null} widget={widget(title)} />);
}

const allowed: UiManifest = { ...golden, allowUnsafeEmbeds: true };
const frame = (container: HTMLElement) => container.querySelector("iframe");

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetQueryClient();
});

describe("core/embed's gate", () => {
  it("frames nothing while the config does not allow embeds, and offers the page in a new tab", async () => {
    const { container } = show(golden);
    expect(await screen.findByText("Embeds are off")).toBeInTheDocument();
    expect(screen.getByText(/ui\.allowUnsafeEmbeds: true/)).toBeInTheDocument();
    expect(frame(container)).toBeNull();
    expect(screen.getByRole("link", { name: /Open grafana\.example\.net/ })).toHaveAttribute("href", URL_);
    expect(screen.getByRole("link", { name: /opens in new tab/ })).toHaveAttribute("target", "_blank");
  });

  it("stays off when the manifest cannot be read", async () => {
    const { container } = show(500);
    expect(await screen.findByText("Embeds are off", {}, { timeout: 5_000 })).toBeInTheDocument();
    expect(frame(container)).toBeNull();
  });

  it("waits for the manifest, framing nothing meanwhile", () => {
    const { container } = show("never");
    expect(screen.getByText("Loading widget…")).toBeInTheDocument();
    expect(frame(container)).toBeNull();
  });
});

describe("core/embed's frame", () => {
  it("frames the page when the config allows embeds: sandboxed, titled, no referrer, lazy", async () => {
    show(allowed);
    const iframe = await screen.findByTitle("UPS graph");
    expect(iframe.tagName).toBe("IFRAME");
    expect(iframe).toHaveAttribute("src", URL_);
    expect(iframe).toHaveAttribute("sandbox", "allow-scripts allow-same-origin");
    expect(iframe).toHaveAttribute("referrerpolicy", "no-referrer");
    expect(iframe).toHaveAttribute("loading", "lazy");
    expect(iframe).toHaveClass("h-96");
    expect(screen.getByRole("link", { name: /Open grafana\.example\.net/ })).toHaveAttribute("href", URL_);
  });

  it("is named by its host when the widget has no title", async () => {
    show(allowed, {}, null);
    expect(await screen.findByTitle("Page from grafana.example.net")).toBeInTheDocument();
  });

  it("takes the widget's sandbox tokens in place of the default, and an empty list allows nothing", async () => {
    const { container, unmount } = show(allowed, { sandbox: ["allow-forms"], height: "lg" });
    const iframe = await screen.findByTitle("UPS graph");
    expect(iframe).toHaveAttribute("sandbox", "allow-forms");
    expect(iframe).toHaveClass("h-144");
    unmount();
    resetQueryClient();
    show(allowed, { sandbox: [] });
    const strict = await screen.findByTitle("UPS graph");
    expect(strict).toHaveAttribute("sandbox", "");
    expect(frame(container)).toBeNull();
  });

  it("never grants a token outside the schema's list, whatever reaches it", () => {
    expect(sandboxOf(["allow-top-navigation", "allow-modals", "allow-forms", "allow-pointer-lock"])).toBe("allow-forms");
    expect(sandboxOf(undefined)).toBe("allow-scripts allow-same-origin");
  });

  it.each([
    ["deck's own origin", () => `${window.location.origin}/hosts`, /own pages/],
    ["a javascript: URL", () => "javascript:alert(1)", /absolute http\(s\) URL/],
    ["a relative path", () => "/hosts", /absolute http\(s\) URL/],
  ])("refuses %s, even with embeds allowed", async (_name, url, message) => {
    const { container } = show(allowed, { url: url() });
    expect(screen.getByRole("alert")).toHaveTextContent(message);
    expect(frame(container)).toBeNull();
  });

  it("reads only http(s) URLs on another origin", () => {
    expect(embedTarget("https://grafana.example.net/x", "http://deck.lab")).toEqual({ url: new URL("https://grafana.example.net/x") });
    expect(embedTarget("http://deck.lab:8080/x", "http://deck.lab")).toHaveProperty("url");
    expect(embedTarget("http://deck.lab/x", "http://deck.lab")).toHaveProperty("problem");
    expect(embedTarget(42, "http://deck.lab")).toHaveProperty("problem");
    expect(embedTarget("data:text/html,x", "http://deck.lab")).toHaveProperty("problem");
  });
});
