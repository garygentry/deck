import { Hono, type Context, type MiddlewareHandler } from "hono";
import type { Logger } from "pino";

import type {
  ApiError,
  DeckConfig,
  HealthResponse,
  ProviderDescriptor,
  ProviderEnvelope,
  ProviderHealthEntry,
  ProvidersResponse,
} from "../contract/index.js";
import type { ActionsDeps } from "../actions/runtime.js";
import { registerActionRoutes } from "../actions/route.js";
import { registerLlmUsageRoutes, type LlmUsageDeps } from "../llm-usage/routes.js";
import { registerMetricsRoutes } from "../metrics/route.js";
import type { ProviderPollMetrics } from "../providers/registry.js";
import { registerSourceRoutes } from "../sources/route.js";
import type { SourceReader } from "../sources/store.js";
import { requestLogger } from "../log/logger.js";

export interface ProviderReader {
  /** Read one cached provider envelope. */
  read(id: string): ProviderEnvelope | undefined;
  /** Return registered provider count. */
  count(): number;
  /** Return cached, deterministic provider health without upstream I/O. */
  listHealth(): Readonly<Record<string, ProviderHealthEntry>>;
  /** Return the registered providers' identities (id + kind) without upstream I/O. */
  listProviders(): readonly ProviderDescriptor[];
  /** Return per-provider poll counters and last-poll latency without upstream I/O. */
  listMetrics?(): readonly ProviderPollMetrics[];
}

export interface AppDeps {
  config: DeckConfig;
  providers: ProviderReader;
  logger: Logger;
  /** Actions capability bundle; absent OR runtime.enabled=false => capability off. */
  actions?: ActionsDeps;
  /** Sources capability registry; absent => capability off (every /api/sources/* → 404). */
  sources?: SourceReader;
  /** LLM usage collector; absent => `llmUsage` not configured (GET routes report enabled:false). */
  llmUsage?: LlmUsageDeps;
  /** DECK_METRICS_ENABLED; absent or false => GET /metrics is not registered (404). */
  metricsEnabled?: boolean;
  webDistDir?: string;
  startedAtMs?: number;
}

type StaticOptions = {
  root: string;
  rewriteRequestPath?: (path: string) => string;
};

/** Keep Bun-only module evaluation out of Node/vitest and defer file access to requests. */
function lazyServeStatic(options: StaticOptions): MiddlewareHandler {
  let middleware: MiddlewareHandler | undefined;
  return async (context, next) => {
    middleware ??= (await import("hono/bun")).serveStatic(options);
    return middleware(context, next);
  };
}

// Must stay a hoisted `function` declaration: `actions/route.ts` imports this
// through a module cycle (app.ts -> actions/route.ts -> app.ts). A `const`/arrow
// binding would sit in the temporal dead zone during that cyclic evaluation.
export function apiError(
  context: Context,
  status: number,
  error: string,
  code?: string,
): Response {
  const body: ApiError = { error, ...(code === undefined ? {} : { code }) };
  return context.json(body, status as 400 | 403 | 404 | 422 | 500);
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  const startedAtMs = deps.startedAtMs ?? Date.now();

  app.use("*", requestLogger(deps.logger));

  app.get("/api/config", (context) => context.json(deps.config));

  app.get("/api/providers", (context) => {
    const response: ProvidersResponse = { providers: [...deps.providers.listProviders()] };
    return context.json(response);
  });

  app.get("/api/providers/:id", (context) => {
    const id = context.req.param("id");
    const envelope = deps.providers.read(id);
    if (envelope === undefined) {
      return apiError(
        context,
        404,
        `No provider registered with id '${id}'`,
        "PROVIDER_NOT_FOUND",
      );
    }
    return context.json(envelope);
  });

  app.get("/api/health", (context) => {
    const providers = deps.providers.listHealth();
    const response: HealthResponse = {
      status: Object.values(providers).some((entry) => !entry.ok) ? "degraded" : "ok",
      uptimeMs: Date.now() - startedAtMs,
      providerCount: deps.providers.count(),
      providers,
      ...(deps.llmUsage ? { llmUsage: deps.llmUsage.collector.health() } : {}),
    };
    return context.json(response);
  });

  app.onError((error, context) => {
    deps.logger.error({ event: "request.error", stack: error.stack }, "request failed");
    return apiError(context, 500, "Internal server error", "INTERNAL");
  });

  app.notFound((context) => {
    if (context.req.path.startsWith("/api/")) {
      return apiError(context, 404, "Not found", "NOT_FOUND");
    }
    // Plain 404 (Hono's default body). Calling context.notFound() here would re-enter
    // this same handler and overflow into the 500 onError path.
    return context.text("404 Not Found", 404);
  });

  // Action routes: after the GET routes and error/notFound boundaries, before the
  // static/SPA fallback so /api/actions/* matches the API rather than the index rewrite.
  registerActionRoutes(app, deps);

  // Source browsing routes: same placement contract (after GET provider routes, before the
  // static/SPA fallback) so /api/sources/* resolves as API (05 §1.2).
  registerSourceRoutes(app, deps);

  // LLM usage routes: same placement contract, so /api/llm-usage* resolves as API.
  registerLlmUsageRoutes(app, deps);

  // Metrics route: outside /api/* (so it never hits the API notFound JSON branch) and
  // before the static/SPA fallback so /metrics is not rewritten to index.html.
  registerMetricsRoutes(app, deps);

  if (deps.webDistDir !== undefined) {
    app.use("/*", lazyServeStatic({ root: deps.webDistDir }));
    const serveIndex = lazyServeStatic({
      root: deps.webDistDir,
      rewriteRequestPath: () => "/index.html",
    });
    app.get("/*", async (context, next) => {
      // /metrics is reserved: with the metrics flag off it must 404, not serve the SPA shell.
      if (context.req.path.startsWith("/api/") || context.req.path === "/metrics") return next();
      return serveIndex(context, next);
    });
  }

  return app;
}
