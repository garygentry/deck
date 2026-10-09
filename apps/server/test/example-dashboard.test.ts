/**
 * The example dashboard layer (`examples/dashboard/20-dashboard.yaml`) added to the example
 * estate: it validates with no finding, and `GET /api/ui` routes its page, lists it in its nav
 * group, and resolves every widget's type and source, so the page the guide walks through works
 * as shipped.
 */
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { UiManifest } from "@deck/module-sdk";
import type { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";

import { capture, createdApps, SERVER_ROOT, SETTLE_TIMEOUT_MS } from "./parity/harness.js";

vi.setConfig({ testTimeout: SETTLE_TIMEOUT_MS * 3 });

vi.mock("../src/server/app.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/server/app.js")>();
  return {
    ...original,
    createApp: (deps: Parameters<typeof original.createApp>[0]): Hono => {
      const app = original.createApp(deps);
      createdApps.push(app);
      return app;
    },
  };
});

const EXAMPLES = join(SERVER_ROOT, "../../examples");

describe("the example dashboard layer", () => {
  it("validates on the example estate and serves its page with every widget resolved", async () => {
    const dir = mkdtempSync(join(tmpdir(), "deck-example-dashboard-"));
    for (const name of readdirSync(join(EXAMPLES, "estate")).filter((file) => file.endsWith(".yaml"))) {
      copyFileSync(join(EXAMPLES, "estate", name), join(dir, name));
    }
    copyFileSync(join(EXAMPLES, "dashboard", "20-dashboard.yaml"), join(dir, "20-dashboard.yaml"));
    let ui = {} as UiManifest;
    try {
      const projection = await capture({ id: "example-dashboard", dir }, {
        onApp: async (app) => {
          ui = (await (await app.request("/api/ui")).json()) as UiManifest;
        },
      });
      expect(projection.validate, projection.validate.stdout).toMatchObject({ exitClass: 0 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    const page = ui.pages.find((entry) => entry.id === "page:ui/pulse");
    expect(page).toMatchObject({ path: "/pulse", title: "Estate pulse" });
    expect(ui.nav).toContainEqual(expect.objectContaining({ id: "nav:ui/pulse", group: "lab", label: "Pulse" }));
    expect(ui.navGroups).toContainEqual(expect.objectContaining({ id: "lab", label: "Lab" }));
    expect(ui.providers).toContainEqual({ id: "deck-health", kind: "http-json" });
    expect(Object.keys(ui.statusMaps ?? {})).toEqual(["deck-status", "healthy"]);
    expect(ui.findings).toEqual([]);

    const widgets = page?.layout?.sections.flatMap((section) => ("widgets" in section ? section.widgets : [])) ?? [];
    expect(widgets.map((widget) => widget.id)).toEqual(["status", "counts", "providers", "shortcuts", "notes"].map((id) => `widget:ui/pulse.${id}`));
    for (const widget of widgets) {
      expect(widget.typeProblem, widget.id).toBeUndefined();
      expect(widget.sourceProblem, widget.id).toBeUndefined();
    }
    expect(widgets.filter((widget) => widget.source !== null).map((widget) => widget.source?.id)).toEqual(["deck-health", "deck-health", "deck-health"]);
  });
});
