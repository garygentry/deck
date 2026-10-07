import type { Page, Route } from "@playwright/test";

/**
 * Fixed portal data for the portal E2E and visual specs. The shared E2E API
 * builds its scenario around "now" and declares no portal groups, so the
 * portal's endpoints are intercepted with this invented estate instead: every
 * card state, a subgroup, icons, and freshness stamps pinned to `PORTAL_NOW`.
 */

export const PORTAL_NOW = new Date("2026-01-15T12:00:00Z");
const OBSERVED_AT = new Date(PORTAL_NOW.getTime() - 30_000).toISOString();
const FRESH = { state: "fresh", observedAt: OBSERVED_AT, ageMs: 30_000, ttlMs: 60_000 };

const service = (name: string, purpose: string, bindings?: Record<string, unknown>, href?: string) => ({
  name,
  host: "atlas",
  kind: "container",
  purpose,
  ...(bindings ? { bindings } : {}),
  ...(href ? { links: [{ title: name, href }] } : {}),
});

export const PORTAL_CONFIG = {
  schemaVersion: 1,
  estate: { name: "Portal fixture estate" },
  hosts: [{ name: "atlas", kind: "bare-metal", purpose: "Primary host" }],
  services: [
    service("grafana", "Dashboards and metrics", { docker: { container: "grafana" } }, "https://grafana.example.test"),
    service("jellyfin", "Media server", { docker: { container: "jellyfin" } }, "https://jellyfin.example.test"),
    service("paperless", "Document archive", { docker: { container: "paperless" } }),
    service("uptime", "External uptime probe", { gatus: { endpoint: "uptime" } }, "https://status.example.test"),
    service("backup", "Nightly backup target"),
  ],
  groups: [
    {
      id: "observability",
      title: "Observability",
      icon: "activity",
      order: 1,
      items: [
        { type: "service", host: "atlas", name: "grafana", title: "Grafana", icon: "activity" },
        { type: "service", host: "atlas", name: "uptime", title: "Uptime" },
        {
          type: "group",
          id: "runbooks",
          title: "Runbooks",
          icon: "book-open",
          items: [
            { type: "link", title: "Incident runbook", href: "https://docs.example.test/incident", description: "What to do when something is down" },
            { type: "link", title: "Restore guide", href: "https://docs.example.test/restore" },
          ],
        },
      ],
    },
    {
      id: "apps",
      title: "Applications",
      icon: "boxes",
      order: 2,
      items: [
        { type: "service", host: "atlas", name: "jellyfin", title: "Jellyfin", icon: "circle-play" },
        { type: "service", host: "atlas", name: "paperless", title: "Paperless", icon: "archive" },
        { type: "service", host: "atlas", name: "backup", title: "Backup" },
        { type: "service", host: "atlas", name: "photos", title: "Photos" },
        {
          type: "link",
          title: "Router admin with a deliberately long title that has to truncate",
          href: "https://router.example.test",
          description: "A long description that wraps onto a second line and is then clamped so the tile keeps its height",
          icon: "server",
        },
      ],
    },
  ],
};

const PROVIDERS = { providers: [{ id: "docker", kind: "docker" }, { id: "gatus", kind: "gatus" }] };

const DOCKER = {
  id: "docker",
  kind: "docker",
  error: null,
  freshness: FRESH,
  data: {
    containers: [
      { name: "grafana", state: "running", health: "healthy", status: "Up 3 days" },
      { name: "jellyfin", state: "exited", health: "none", status: "Exited (1)" },
    ],
  },
};

const GATUS = {
  id: "gatus",
  kind: "gatus",
  error: null,
  freshness: FRESH,
  data: { endpoints: [{ key: "uptime", up: true, latencyMs: 42 }] },
};

const BODIES: Record<string, unknown> = {
  "/api/config": PORTAL_CONFIG,
  "/api/providers": PROVIDERS,
  "/api/providers/docker": DOCKER,
  "/api/providers/gatus": GATUS,
};

/** Serve the fixed portal estate for `/api/config` and the portal's providers. */
export async function routePortalFixture(page: Page): Promise<void> {
  await page.route(
    (url) => url.pathname in BODIES,
    (route: Route) => route.fulfill({ json: BODIES[new URL(route.request().url()).pathname] }),
  );
}
