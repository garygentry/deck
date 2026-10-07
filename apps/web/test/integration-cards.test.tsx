// @vitest-environment jsdom
import type { Integration } from "@deck/schema";
import type { FreshnessStamp } from "@deck/server";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { IntegrationsSection } from "../src/features/alerts-and-health/IntegrationsSection.js";
import { IntegrationCard } from "../src/features/alerts-and-health/IntegrationCard.js";
import type { AlertmanagerData } from "../src/features/alerts-and-health/useAlertmanagerData.js";
import type { PrometheusData } from "../src/features/alerts-and-health/usePrometheusData.js";

afterEach(cleanup);

// ---------------------------------------------------------------------------
// Prop-driven components. All identities are invented and deterministic; no hook
// or network is involved.
// ---------------------------------------------------------------------------

const FRESH: FreshnessStamp = { state: "fresh", observedAt: null, ageMs: 1000, ttlMs: 30000 };

/** A resolved-but-empty (not-configured) hook view: no envelope was ever returned. */
const NOT_CONFIGURED_AM: AlertmanagerData = { data: null, freshness: null, error: null, loading: false };
const NOT_CONFIGURED_PROM: PrometheusData = { data: null, freshness: null, error: null, loading: false };

function integration(overrides: Partial<Integration> & Pick<Integration, "id" | "kind">): Integration {
  return {
    title: `${overrides.kind} tool`,
    baseUrl: `https://base.example/${overrides.id}`,
    ...overrides,
  };
}

function renderSection(
  integrations: Integration[],
  views: { alertmanager?: AlertmanagerData; prometheus?: PrometheusData; configLoading?: boolean } = {},
): HTMLElement {
  render(
    <IntegrationsSection
      integrations={integrations}
      configLoading={views.configLoading ?? false}
      alertmanager={views.alertmanager ?? NOT_CONFIGURED_AM}
      prometheus={views.prometheus ?? NOT_CONFIGURED_PROM}
    />,
  );
  return screen.getByRole("region", { name: "Integrations" });
}

/** The tile link for an integration title (its name also carries the new-tab note). */
const tile = (title: string): HTMLElement =>
  screen.getByRole("link", { name: `${title} (opens in new tab)` });

describe("IntegrationsSection", () => {
  it("renders one tile per entry, grouped by kind, groups sorted alphabetically", () => {
    const section = renderSection([
      integration({ id: "graf", kind: "grafana" }),
      integration({ id: "am", kind: "alertmanager" }),
      integration({ id: "prom", kind: "prometheus" }),
    ]);

    expect(within(section).getAllByRole("link")).toHaveLength(3);
    const groups = within(section)
      .getAllByRole("region")
      .map((g) => g.querySelector("h3")?.textContent);
    expect(groups).toEqual([
      "alertmanager integrations",
      "grafana integrations",
      "prometheus integrations",
    ]);
    expect(
      within(screen.getByRole("region", { name: "grafana integrations" })).getByRole("link", {
        name: "grafana tool (opens in new tab)",
      }),
    ).toBeTruthy();
  });

  it("deep-links to deepLink when present, else baseUrl, always in a new tab", () => {
    renderSection([
      integration({ id: "a", kind: "grafana", title: "A", deepLink: "https://deep.example/a", baseUrl: "https://base.example/a" }),
      integration({ id: "b", kind: "traefik", title: "B", baseUrl: "https://base.example/b" }),
    ]);

    expect(tile("A").getAttribute("href")).toBe("https://deep.example/a");
    expect(tile("B").getAttribute("href")).toBe("https://base.example/b");
    for (const link of [tile("A"), tile("B")]) {
      expect(link.getAttribute("target")).toBe("_blank");
      expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    }
  });

  it("shows live status on the first same-kind tile and a plain link on the second", () => {
    renderSection(
      [
        integration({ id: "am1", kind: "alertmanager", title: "First" }),
        integration({ id: "am2", kind: "alertmanager", title: "Second" }),
      ],
      {
        alertmanager: {
          data: { alerts: [], silences: [], firingCount: 0 },
          freshness: FRESH,
          error: null,
          loading: false,
        },
      },
    );

    expect(within(tile("First")).getByText("0 firing")).toBeTruthy();
    expect(within(tile("First")).getByText("Fresh")).toBeTruthy();
    expect(within(tile("Second")).queryByText(/firing/)).toBeNull();
    expect(within(tile("Second")).queryByText("Fresh")).toBeNull();
  });

  it("renders an unknown/opaque kind as a plain link with no status and no error", () => {
    renderSection([integration({ id: "graf", kind: "grafana", title: "Graf" })]);
    const link = tile("Graf");
    expect(within(link).getByText("grafana")).toBeTruthy();
    expect(link.querySelector('[data-slot="status-badge"]')).toBeNull();
    expect(within(link).queryByText(/Error|Not configured/)).toBeNull();
  });

  it("surfaces a quiet 'Not configured' status (not an error) when the provider is unset", () => {
    renderSection([integration({ id: "prom", kind: "prometheus", title: "Prom" })]);
    const link = tile("Prom");
    expect(within(link).getByText("Not configured")).toBeTruthy();
    expect(within(link).queryByText("Error")).toBeNull();
    // Status is text + a decorative icon, never colour alone.
    expect(within(link).getByText("Not configured").parentElement!.querySelector("svg")).not.toBeNull();
  });

  it("renders a single quiet empty note when there are no integrations", () => {
    const section = renderSection([]);
    expect(section.getAttribute("data-state")).toBe("empty");
    expect(within(section).getByRole("status").textContent).toContain("No integrations configured");
    expect(within(section).queryAllByRole("link")).toHaveLength(0);
  });

  it("renders a pending note while config is loading", () => {
    const section = renderSection([], { configLoading: true });
    expect(within(section).getByRole("status", { name: "Loading integrations…" })).toBeTruthy();
    expect(section.hasAttribute("data-state")).toBe(false);
  });
});

describe("IntegrationCard live status", () => {
  function renderCard(
    kind: "alertmanager" | "prometheus",
    view: AlertmanagerData | PrometheusData,
    extra: Partial<Integration> = {},
  ): HTMLElement {
    const live =
      kind === "alertmanager"
        ? { kind, view: view as AlertmanagerData }
        : { kind, view: view as PrometheusData };
    render(<IntegrationCard integration={integration({ id: kind, kind, title: "Tool", ...extra })} live={live} />);
    return tile("Tool");
  }

  it("shows the firing count with critical tone when alerts are firing", () => {
    const link = renderCard("alertmanager", {
      data: { alerts: [], silences: [], firingCount: 3 },
      freshness: FRESH,
      error: null,
      loading: false,
    });
    const badge = within(link).getByText("3 firing").closest('[data-slot="status-badge"]');
    expect(badge?.getAttribute("data-tone")).toBe("danger");
  });

  it("shows 'Reachable · N breaching' for prometheus with breaching summaries", () => {
    const link = renderCard("prometheus", {
      data: {
        summaries: [
          { id: "a", label: "A", value: 1, status: "ok" },
          { id: "b", label: "B", value: 2, status: "warning" },
          { id: "c", label: "C", value: 3, status: "critical" },
        ],
      },
      freshness: FRESH,
      error: null,
      loading: false,
    });
    const badge = within(link).getByText("Reachable · 2 breaching").closest('[data-slot="status-badge"]');
    expect(badge?.getAttribute("data-tone")).toBe("warn");
  });

  it("renders the error state with freshness when the source is unreachable", () => {
    const link = renderCard("alertmanager", {
      data: null,
      freshness: { state: "unreachable", observedAt: null, ageMs: 90000, ttlMs: 30000 },
      error: { message: "boom-secret-detail" },
      loading: false,
    });
    expect(within(link).getByText("Error")).toBeTruthy();
    expect(within(link).getByText("Unreachable")).toBeTruthy();
    // The server error message is never leaked into the tile.
    expect(link.textContent).not.toContain("boom-secret-detail");
  });

  it("never renders a credentialEnv name in the tile", () => {
    const link = renderCard("prometheus", NOT_CONFIGURED_PROM, { credentialEnv: "PROM_SECRET_TOKEN" });
    expect(document.body.textContent).not.toContain("PROM_SECRET_TOKEN");
    expect(within(link).getByText("Not configured")).toBeTruthy();
  });

  it("has no focusable element nested inside the tile link", () => {
    const link = renderCard("alertmanager", {
      data: { alerts: [], silences: [], firingCount: 0 },
      freshness: FRESH,
      error: null,
      loading: false,
    });
    expect(link.querySelectorAll("a, button, [tabindex]")).toHaveLength(0);
  });
});
