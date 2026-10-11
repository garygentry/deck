import "../src/registry/discover.js";

import { primary } from "@deck/schema/fixtures";
import { renderHtml as render } from "./support/render.js";
import { afterEach, expect, it, vi } from "vitest";
import { App } from "../src/shell/App.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Stub GET /api/config so the shell's useConfig/usePortalData never hit the network. */
function stubConfigFetch(): void {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json(primary.merged)));
}

it("renders the shell and dogfooded home feature with semantic landmarks", () => {
  vi.stubGlobal("location", new URL("http://localhost/"));
  stubConfigFetch();

  let html = "";
  expect(() => {
    html = render(<App />);
  }).not.toThrow();

  expect(html).toMatch(/<header[ >]/);
  expect(html).toMatch(/<nav[ >]/);
  expect(html).toMatch(/<main[ >]/);
  expect(html).toContain('data-slot="health-header"');
  expect(html).toContain('data-testid="portal"');
});

it("mounts the persistent HealthHeader region inside the shell <header> on a non-home route", () => {
  vi.stubGlobal("location", new URL("http://localhost/drift"));
  stubConfigFetch();

  let html = "";
  expect(() => {
    // Drive a non-home route via the App url prop to prove the region is global,
    // rendered by the shell on every route — not by per-page opt-in.
    html = render(<App url="/drift" />);
  }).not.toThrow();

  expect(html).toMatch(/<header[^>]*>[\s\S]*data-slot="health-header"[\s\S]*<\/header>/);
});

it("renders an empty HealthHeader region without throwing when no fragment is registered", async () => {
  // A fresh module graph with the slot declared but no feature discovered, so the
  // slot has zero registered fragments. The container must still render.
  vi.resetModules();
  const { HealthHeaderRegion } = await import(
    "../src/shell/health-header/HealthHeaderRegion.js"
  );

  let html = "";
  expect(() => {
    html = render(<HealthHeaderRegion />);
  }).not.toThrow();

  expect(html).toContain('data-slot="health-header"');
  expect(html).toMatch(/<div data-slot="health-header"[^>]*><\/div>/);
});
