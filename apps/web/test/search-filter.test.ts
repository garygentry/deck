import type { Service } from "@deck/schema";
import type { LinkItem, ServiceItem } from "@deck/server/portal";
import { describe, expect, test } from "vitest";
import { applyFilters, emptyCriteria, matchesCriteria, type FilterCriteria } from "@/ui";
import type { CardStatus, CardViewModel } from "../src/features/portal/card-status.js";
import {
  cardSearchFields,
  PORTAL_FACETS,
  PORTAL_FILTER_ACCESSORS,
  type IndexedCard,
  type PortalFacet,
} from "../src/features/portal/search-filter.js";

// The portal's keyboard grammar lives in the shared resolver now; its legacy
// cases are ported in ui-list-navigation.test.ts ("ported: portal card grid").

const freshness = { state: "static", observedAt: null, ageMs: null, ttlMs: null } as const;

function indexed(
  item: ServiceItem | LinkItem,
  status: CardStatus,
  groupId: string,
  groupTitle: string,
  resolvedService?: Service,
): IndexedCard {
  const card: CardViewModel = { item, status, freshness };
  if (resolvedService) card.resolvedService = resolvedService;
  return { card, groupId, groupTitle };
}

function criteria(
  query = "",
  facets: Partial<Record<PortalFacet, readonly string[]>> = {},
): FilterCriteria<PortalFacet> {
  const base = emptyCriteria(PORTAL_FACETS);
  return {
    query,
    facets: {
      status: new Set(facets.status ?? base.facets.status),
      group: new Set(facets.group ?? base.facets.group),
    },
  };
}

const matches = (entry: IndexedCard, value: FilterCriteria<PortalFacet>): boolean =>
  matchesCriteria(entry, value, PORTAL_FILTER_ACCESSORS);

const serviceItem: ServiceItem = {
  type: "service",
  host: "lab",
  name: "grafana",
  title: "Dashboards",
  description: "Metrics overview",
};
const resolvedService: Service = {
  host: "lab",
  name: "Grafana",
  kind: "container",
  purpose: "Visualize Telemetry",
};
const linkItem: LinkItem = {
  type: "link",
  title: "Runbook",
  href: "https://example.test/runbook",
  description: "Operator docs",
};

describe("search and filtering", () => {
  const cards = [
    indexed(serviceItem, "bound-up", "monitoring", "Observability", resolvedService),
    indexed(linkItem, "static", "docs", "Documentation"),
    indexed({ type: "service", host: "lab", name: "missing-api" }, "broken-reference", "apps", "Applications"),
    indexed({ type: "service", host: "lab", name: "database", title: "Storage" }, "bound-down", "apps", "Applications", {
      host: "lab", name: "Postgres", kind: "container", purpose: "Persistent data",
    }),
    indexed({ type: "service", host: "lab", name: "proxy" }, "unreachable", "network", "Networking", {
      host: "lab", name: "Proxy", kind: "container", purpose: "Ingress",
    }),
  ] as const;

  test("extracts lowercase item, resolved service, and top-level group fields", () => {
    expect(cardSearchFields(cards[0])).toEqual([
      "observability", "dashboards", "metrics overview", "grafana", "visualize telemetry",
    ]);
    expect(cardSearchFields(cards[1])).toEqual(["documentation", "runbook", "operator docs"]);
  });

  test.each(["dash", "GRAFANA", "telemetry", "observab"])(
    "matches case-insensitive substring %s",
    (query) => expect(matches(cards[0], criteria(query))).toBe(true),
  );

  test("empty queries match all and broken references use their declared name", () => {
    expect(matches(cards[0], criteria("  "))).toBe(true);
    expect(matches(cards[2], criteria("MISSING-API"))).toBe(true);
  });

  test("maps live statuses and excludes non-live cards from active status filters", () => {
    expect(matches(cards[0], criteria("", { status: ["up"] }))).toBe(true);
    expect(matches(cards[3], criteria("", { status: ["down"] }))).toBe(true);
    expect(matches(cards[4], criteria("", { status: ["unreachable"] }))).toBe(true);
    for (const status of ["static", "not-found", "broken-reference"] as const) {
      const entry = indexed(linkItem, status, "docs", "Docs");
      expect(matches(entry, criteria("", { status: ["up", "down", "unreachable"] }))).toBe(false);
    }
    expect(matches(cards[1], criteria())).toBe(true);
  });

  test("matches selected top-level groups and treats an empty selection as all", () => {
    expect(matches(cards[0], criteria("", { group: ["monitoring"] }))).toBe(true);
    expect(matches(cards[0], criteria("", { group: ["docs"] }))).toBe(false);
    expect(matches(cards[0], criteria())).toBe(true);
  });

  test("returns empty input and preserves all input order with no filters", () => {
    expect(applyFilters([], criteria(), PORTAL_FILTER_ACCESSORS).rows).toEqual([]);
    expect(applyFilters(cards, criteria(), PORTAL_FILTER_ACCESSORS).rows).toEqual(cards);
  });

  test("AND-composes text, live status, and top-level group while preserving order", () => {
    const mixed = [cards[3], cards[0], cards[4]];
    const result = applyFilters(
      mixed,
      criteria("a", { status: ["up", "down"], group: ["apps", "monitoring"] }),
      PORTAL_FILTER_ACCESSORS,
    );
    expect(result.rows).toEqual([cards[3], cards[0]]);
    expect(result.hidden).toBe(1);
  });
});
