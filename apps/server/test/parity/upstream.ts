/**
 * Deterministic upstream for the parity harness: a `fetch` stand-in that answers known
 * URLs with canned bodies, so the success paths of the network providers (status mapping
 * and parsing) are pinned in the goldens, not only their failure paths.
 *
 * - `parity-upstream.invalid/<service>` serves the `v1-integrations` fixture.
 * - The fixed `127.0.0.1` ports serve the `portal-estate` and `alerts-estate` fixtures.
 * - Any other URL rejects like an unreachable host, which keeps the network-error path pinned.
 *
 * A routed URL also checks the request: a wrong method gets 405, and a route that names a
 * credential gets 401 without that exact `Authorization` header. {@link setUpstreamOffline}
 * makes every URL reject, for the routed → unrouted freshness transition.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

const FIXTURES = join(__dirname, "../fixtures");

/** The rejection every unrouted URL gets; it appears verbatim in the goldens. */
export const UNROUTED_MESSAGE = "network disabled in parity harness";

/** The `Authorization` value the routed gatus requires (the fixture's `credentialEnv`). */
export const PARITY_GATUS_AUTHORIZATION = "Bearer parity-gatus-token";

interface Route {
  prefix: string;
  service: Service;
  /** The method the provider must use; default GET. */
  method?: string;
  /** The exact `Authorization` header the route requires. */
  authorization?: string;
}

/** URL prefix (host + path) → canned upstream service. */
const ROUTES: readonly Route[] = [
  { prefix: "parity-upstream.invalid/docker", service: "docker" },
  { prefix: "parity-upstream.invalid/gatus", service: "gatus", authorization: PARITY_GATUS_AUTHORIZATION },
  { prefix: "parity-upstream.invalid/prometheus", service: "prometheus" },
  { prefix: "parity-upstream.invalid/alertmanager", service: "alertmanager" },
  { prefix: "parity-upstream.invalid/web/health", service: "health-ok" },
  { prefix: "parity-upstream.invalid/api/health", service: "health-503", method: "HEAD" },
  { prefix: "127.0.0.1:65534", service: "docker" },
  { prefix: "127.0.0.1:65533", service: "gatus" },
  { prefix: "127.0.0.1:65532", service: "prometheus" },
  { prefix: "127.0.0.1:65531", service: "alertmanager" },
];

let offline = false;

/** Make every URL reject (true) or restore routing (false). */
export function setUpstreamOffline(value: boolean): void {
  offline = value;
}

type Service = "docker" | "gatus" | "prometheus" | "alertmanager" | "health-ok" | "health-503";

const DOCKER_CONTAINERS = [
  { Names: ["/site"], State: "running", Status: "Up 2 hours (healthy)" },
  { Names: ["/worker"], State: "running", Status: "Up 1 minute (unhealthy)" },
  { Names: ["/migrate"], State: "exited", Status: "Exited (0) 1 hour ago" },
  { Names: ["/cache"], State: "restarting", Status: "Up 2 seconds (health: starting)" },
];

const GATUS_STATUSES = [
  {
    key: "core_site",
    name: "Site",
    group: "Core",
    results: [{ success: true, duration: 1_600_000 }],
    uptime: 99.99,
  },
  {
    key: "core_api",
    name: "API",
    group: "Core",
    results: [{ success: false, duration: 999_000_000 }],
    uptime: 92.5,
  },
  { key: "no-results", name: "Waiting" },
];

/** PromQL query → canned response file in `fixtures/prometheus/`. */
const PROMETHEUS_QUERIES: Record<string, string> = {
  "avg(node_load1)": "healthy.json",
  "avg(node_memory_used_percent)": "warn.json",
  "min(node_filesystem_free_percent)": "no-data.json",
  bad_shape_metric: "bad-shape.json",
};

function fixtureJson(...path: string[]): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, ...path), "utf8"));
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function respond(service: Service, rest: string, url: URL): Response {
  switch (service) {
    case "health-ok":
      return new Response("ok", { status: 200, headers: { "content-type": "text/plain" } });
    case "health-503":
      return new Response("unavailable", { status: 503, headers: { "content-type": "text/plain" } });
    case "docker":
      return rest === "/containers/json" ? json(DOCKER_CONTAINERS) : json({ message: "not found" }, 404);
    case "gatus":
      return rest === "/api/v1/endpoints/statuses" ? json(GATUS_STATUSES) : json({ error: "not found" }, 404);
    case "prometheus": {
      const file = rest === "/api/v1/query" ? PROMETHEUS_QUERIES[url.searchParams.get("query") ?? ""] : undefined;
      return file === undefined
        ? json({ status: "error", errorType: "bad_data", error: "unknown parity query" }, 400)
        : json(fixtureJson("prometheus", file));
    }
    case "alertmanager": {
      if (rest === "/api/v2/alerts") return json((fixtureJson("alertmanager", "firing.json") as { alerts: unknown }).alerts);
      if (rest === "/api/v2/silences") {
        return json((fixtureJson("alertmanager", "silenced.json") as { silences: unknown }).silences);
      }
      return json({ error: "not found" }, 404);
    }
  }
}

/** The `fetch` stub: routed URLs get canned responses; anything else rejects. */
export async function upstreamFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const location = `${url.host}${url.pathname}`.replace(/\/{2,}/g, "/");
  const route = offline
    ? undefined
    : ROUTES.find(({ prefix }) => location === prefix || location.startsWith(`${prefix}/`));
  if (route === undefined) throw new TypeError(UNROUTED_MESSAGE);

  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  if (method !== (route.method ?? "GET")) return json({ error: `method ${method} not allowed` }, 405);
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  if (route.authorization !== undefined && headers.get("authorization") !== route.authorization) {
    return json({ error: "unauthorized" }, 401);
  }
  return respond(route.service, location.slice(route.prefix.length) || "/", url);
}
