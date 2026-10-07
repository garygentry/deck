// @vitest-environment jsdom
import { act, cleanup, render, screen, within } from "@testing-library/react";
import type { JSX } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The entity pages are open: a module attaches a section to `entity:host/sections` or
 * `entity:service/sections` by its id, and the page renders it with no change to the host.
 * Each test gets a fresh registry, so the sections it attaches stay its own.
 */
async function freshHost() {
  vi.resetModules();
  const registry = await import("../src/registry/registry.js");
  const { EntitySections } = await import("../src/features/hosts-and-services/components/EntitySections.js");
  return { registry, EntitySections };
}

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
    const { registry, EntitySections } = await freshHost();
    // The built-ins' placement: findings at 10, configs at 20.
    registry.registerEntityFragment({ id: "section:drift/host-findings", entity: "host", section: "findings", title: "Findings", order: 10, component: text("FINDINGS") });
    registry.registerEntityFragment({ id: "section:sources/host-configs", entity: "host", section: "configs", title: "Configs", order: 20, component: text("CONFIGS") });
    registry.registerEntityFragment({ id: "section:backups/host", entity: "host", title: "Backups", order: 15, component: text("BACKUPS") });

    render(<EntitySections entity={Object.freeze({ entity: "host", host: "alpha" })} />);
    expect(headings()).toEqual(["Findings", "Backups", "Configs"]);
    const backups = screen.getByRole("region", { name: "Backups" });
    // A section naming none is its module's own: `<module>.<name>`.
    expect(backups).toHaveAttribute("data-entity-slot", "backups.host");
    expect(within(backups).getByRole("heading")).toHaveAttribute("id", "entity-slot-backups.host");
    expect(within(backups).getByText("BACKUPS")).toBeInTheDocument();
  });

  it("renders fragments that share a section under its first fragment's heading", async () => {
    const { registry, EntitySections } = await freshHost();
    registry.registerEntityFragment({ id: "section:drift/host-findings", entity: "host", section: "findings", title: "Findings", order: 10, component: text("DRIFT") });
    registry.registerEntityFragment({ id: "section:audit/host-findings", entity: "host", section: "findings", title: "Audit", order: 50, component: text("AUDIT") });

    render(<EntitySections entity={Object.freeze({ entity: "host", host: "alpha" })} />);
    expect(headings()).toEqual(["Findings"]);
    const findings = screen.getByRole("region", { name: "Findings" }).textContent ?? "";
    expect(findings.indexOf("DRIFT")).toBeLessThan(findings.indexOf("AUDIT"));
  });

  it("renders two modules' same-named sections apart, each under its own heading", async () => {
    const { registry, EntitySections } = await freshHost();
    registry.registerEntityFragment({ id: "section:backups/host", entity: "host", title: "Backups", order: 10, component: text("BACKUPS") });
    registry.registerEntityFragment({ id: "section:audit/host", entity: "host", title: "Audit", order: 20, component: text("AUDIT") });

    render(<EntitySections entity={Object.freeze({ entity: "host", host: "alpha" })} />);
    expect(headings()).toEqual(["Backups", "Audit"]);
    expect(within(screen.getByRole("region", { name: "Audit" })).getByText("AUDIT")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Backups" })).queryByText("AUDIT")).toBeNull();
  });

  it("keeps host and service sections apart, and a section added later renders", async () => {
    const { registry, EntitySections } = await freshHost();
    registry.registerEntityFragment({ id: "section:x/host", entity: "host", title: "Host only", component: text("HOST") });
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
});
