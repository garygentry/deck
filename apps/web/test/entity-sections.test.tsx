// @vitest-environment jsdom
import { act, cleanup, render, screen, within } from "@testing-library/react";
import type { JSX } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { UiManifestAnswer } from "../src/data/queries.js";
import { manifestPlacing } from "./support/manifest.js";

/**
 * The entity pages are open: a module attaches a section to `entity:host/sections` or
 * `entity:service/sections` by its id, and the page renders it with no change to the host.
 * Each test gets a fresh registry, so the sections it attaches stay its own.
 */
async function freshHost() {
  vi.resetModules();
  const registry = await import("../src/registry/registry.js");
  const { EntitySections } = await import("../src/features/hosts-and-services/components/EntitySections.js");
  const { getQueryClient } = await import("../src/data/query-client.js");
  const { queryKeys } = await import("../src/data/queries.js");
  /** Serve a UI manifest: by default one placing every registered extension (every module on). */
  const serve = (manifest: UiManifestAnswer = manifestPlacing(registry.getAllExtensions())) =>
    getQueryClient().setQueryData(queryKeys.uiManifest, manifest);
  return { registry, EntitySections, serve };
}

/** A manifest entry placing an entity section, with its resolved config (title, section). */
const FINDINGS = { section: "findings", title: "Findings" };
const CONFIGS = { section: "configs", title: "Configs" };
const placed = (id: `${string}:${string}/${string}`, entity: "host" | "service", order: number, config?: Record<string, string>) => ({
  id, kind: "entity-section", module: id.split(/[:/]/)[1]!, slot: `entity:${entity}/sections`, order, ...(config === undefined ? {} : { config }),
});

const text = (label: string) => (): JSX.Element => <span>{label}</span>;
const headings = () => screen.getAllByRole("heading").map((heading) => heading.textContent);

beforeEach(() => {
  cleanup();
});
afterEach(() => {
  cleanup();
});

describe("open entity sections", () => {
  it("renders a section any module attaches, between the built-ins by order", async () => {
    const { registry, EntitySections, serve } = await freshHost();
    // The built-ins' placement: findings at 10, configs at 20.
    registry.registerEntityFragment({ id: "section:drift/host-findings", entity: "host", section: "findings", title: "Findings", order: 10, component: text("FINDINGS") });
    registry.registerEntityFragment({ id: "section:sources/host-configs", entity: "host", section: "configs", title: "Configs", order: 20, component: text("CONFIGS") });
    registry.registerEntityFragment({ id: "section:backups/host", entity: "host", title: "Backups", order: 15, component: text("BACKUPS") });

    serve();
    render(<EntitySections entity={Object.freeze({ entity: "host", host: "alpha" })} />);
    expect(headings()).toEqual(["Findings", "Backups", "Configs"]);
    const backups = screen.getByRole("region", { name: "Backups" });
    // A section naming none is its module's own: `<module>.<name>`.
    expect(backups).toHaveAttribute("data-entity-slot", "backups.host");
    expect(within(backups).getByRole("heading")).toHaveAttribute("id", "entity-slot-backups.host");
    expect(within(backups).getByText("BACKUPS")).toBeInTheDocument();
  });

  it("renders fragments that share a section under its first fragment's heading", async () => {
    const { registry, EntitySections, serve } = await freshHost();
    registry.registerEntityFragment({ id: "section:drift/host-findings", entity: "host", section: "findings", title: "Findings", order: 10, component: text("DRIFT") });
    registry.registerEntityFragment({ id: "section:audit/host-findings", entity: "host", section: "findings", title: "Audit", order: 50, component: text("AUDIT") });

    serve();
    render(<EntitySections entity={Object.freeze({ entity: "host", host: "alpha" })} />);
    expect(headings()).toEqual(["Findings"]);
    const findings = screen.getByRole("region", { name: "Findings" }).textContent ?? "";
    expect(findings.indexOf("DRIFT")).toBeLessThan(findings.indexOf("AUDIT"));
  });

  it("renders two modules' same-named sections apart, each under its own heading", async () => {
    const { registry, EntitySections, serve } = await freshHost();
    registry.registerEntityFragment({ id: "section:backups/host", entity: "host", title: "Backups", order: 10, component: text("BACKUPS") });
    registry.registerEntityFragment({ id: "section:audit/host", entity: "host", title: "Audit", order: 20, component: text("AUDIT") });

    serve();
    render(<EntitySections entity={Object.freeze({ entity: "host", host: "alpha" })} />);
    expect(headings()).toEqual(["Backups", "Audit"]);
    expect(within(screen.getByRole("region", { name: "Audit" })).getByText("AUDIT")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Backups" })).queryByText("AUDIT")).toBeNull();
  });

  it("keeps host and service sections apart, and a section added later renders", async () => {
    const { registry, EntitySections, serve } = await freshHost();
    registry.registerEntityFragment({ id: "section:x/host", entity: "host", title: "Host only", component: text("HOST") });
    // The manifest lists the service section; the web registers it later (a late-loading module).
    serve({ ...manifestPlacing(registry.getAllExtensions()), extensions: [placed("section:x/host", "host", 100, { title: "Host only" }), placed("section:x/service", "service", 100, { title: "Service only" })] });
    const service = Object.freeze({ entity: "service" as const, host: "alpha", name: "api" });
    const view = render(<EntitySections entity={service} />);
    expect(view.container).toBeEmptyDOMElement();

    // The registry is reactive: a late registration re-renders the page.
    act(() => {
      registry.registerEntityFragment({ id: "section:x/service", entity: "service", title: "Service only", component: text("SERVICE") });
    });
    expect(screen.getByRole("heading", { name: "Service only" })).toBeInTheDocument();
    expect(screen.queryByText("HOST")).toBeNull();
  });

  it("places sections where the UI manifest puts them, not where the web registered them", async () => {
    const { registry, EntitySections, serve } = await freshHost();
    registry.registerEntityFragment({ id: "section:drift/host-findings", entity: "host", section: "findings", title: "Findings", order: 10, component: text("FINDINGS") });
    registry.registerEntityFragment({ id: "section:sources/host-configs", entity: "host", section: "configs", title: "Configs", order: 20, component: text("CONFIGS") });
    serve({ ...manifestPlacing([]), extensions: [placed("section:sources/host-configs", "host", 5, CONFIGS), placed("section:drift/host-findings", "host", 50, FINDINGS)] });

    render(<EntitySections entity={Object.freeze({ entity: "host", host: "alpha" })} />);
    expect(headings()).toEqual(["Configs", "Findings"]);
  });

  it("heads and groups sections by the manifest's resolved config, which replaces the registered one", async () => {
    const { registry, EntitySections, serve } = await freshHost();
    registry.registerEntityFragment({ id: "section:drift/host-findings", entity: "host", section: "findings", title: "Findings", order: 10, component: text("FINDINGS") });
    registry.registerEntityFragment({ id: "section:audit/host-findings", entity: "host", section: "findings", title: "Audit", order: 20, component: text("AUDIT") });
    registry.registerEntityFragment({ id: "section:sources/host-configs", entity: "host", section: "configs", title: "Configs", order: 30, component: text("CONFIGS") });
    const host = Object.freeze({ entity: "host" as const, host: "alpha" });

    // A changed title heads the section.
    serve({ ...manifestPlacing([]), extensions: [
      placed("section:drift/host-findings", "host", 10, { section: "findings", title: "Drift" }),
      placed("section:sources/host-configs", "host", 30, { section: "configs", title: "Owned configs" }),
    ] });
    let view = render(<EntitySections entity={host} />);
    expect(headings()).toEqual(["Drift", "Owned configs"]);
    view.unmount();

    // A changed section moves the extension: audit leaves findings for a section of its own name.
    serve({ ...manifestPlacing([]), extensions: [
      placed("section:drift/host-findings", "host", 10, { section: "findings", title: "Findings" }),
      placed("section:audit/host-findings", "host", 20, { section: "audit", title: "Audit" }),
    ] });
    view = render(<EntitySections entity={host} />);
    expect(headings()).toEqual(["Findings", "Audit"]);
    expect(within(screen.getByRole("region", { name: "Audit" })).getByText("AUDIT")).toBeInTheDocument();
    expect(document.querySelector('[data-entity-slot="audit"]')).not.toBeNull();
    view.unmount();

    // No explicit section (replaced wholesale, not merged): the extension's own `<module>.<name>`.
    serve({ ...manifestPlacing([]), extensions: [
      placed("section:drift/host-findings", "host", 10, { section: "findings", title: "Findings" }),
      placed("section:audit/host-findings", "host", 20, { title: "Audit" }),
    ] });
    render(<EntitySections entity={host} />);
    expect(headings()).toEqual(["Findings", "Audit"]);
    expect(document.querySelector('[data-entity-slot="audit.host-findings"]')).not.toBeNull();
    expect(within(screen.getByRole("region", { name: "Findings" })).queryByText("AUDIT")).toBeNull();
  });

  it("renders nothing for a module that is off: no heading, no region, no placeholder", async () => {
    const { registry, EntitySections, serve } = await freshHost();
    registry.registerEntityFragment({ id: "section:drift/host-findings", entity: "host", section: "findings", title: "Findings", order: 10, component: text("FINDINGS") });
    registry.registerEntityFragment({ id: "section:sources/host-configs", entity: "host", section: "configs", title: "Configs", order: 20, component: text("CONFIGS") });
    // `/api/ui` drops every extension of a module that is not enabled: here, drift's.
    serve({ ...manifestPlacing([]), extensions: [placed("section:sources/host-configs", "host", 20, CONFIGS)] });

    render(<EntitySections entity={Object.freeze({ entity: "host", host: "alpha" })} />);
    expect(headings()).toEqual(["Configs"]);
    expect(screen.queryByRole("region", { name: "Findings" })).toBeNull();
    expect(document.querySelector('[data-entity-slot="findings"]')).toBeNull();
    expect(document.body.textContent).toBe("ConfigsCONFIGS");

    // Every module with sections off: the host renders nothing at all.
    cleanup();
    serve({ ...manifestPlacing([]), extensions: [] });
    const { container } = render(<EntitySections entity={Object.freeze({ entity: "host", host: "alpha" })} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing while the manifest loads, and the registered sections if it cannot be read", async () => {
    const { registry, EntitySections, serve } = await freshHost();
    registry.registerEntityFragment({ id: "section:drift/host-findings", entity: "host", section: "findings", title: "Findings", order: 10, component: text("FINDINGS") });
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
    try {
      const { container, unmount } = render(<EntitySections entity={Object.freeze({ entity: "host", host: "alpha" })} />);
      expect(container).toBeEmptyDOMElement();
      unmount();
    } finally {
      vi.unstubAllGlobals();
    }
    serve({ unavailable: true, message: "HTTP 502" });
    render(<EntitySections entity={Object.freeze({ entity: "host", host: "alpha" })} />);
    expect(headings()).toEqual(["Findings"]);
  });
});
