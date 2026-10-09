import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { apiErrorBody, type UiManifest } from "@deck/module-sdk";
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
import type { ModuleHost } from "../modules/host.js";
import type { ProviderSelects } from "../providers/registry.js";
import { requestLogger } from "../log/logger.js";
import { etagMatches, etagOf, type LiveUi } from "../ui/live.js";
import { deckBootOf, renderIndexHtml } from "./index-html.js";
import { RESERVED_ROOT_PATHS } from "./reserved-paths.js";

export interface ProviderReader {
  /** Read one cached provider envelope. */
  read(id: string): ProviderEnvelope | undefined;
  /** Return registered provider count. */
  count(): number;
  /** Return cached, deterministic provider health without upstream I/O. */
  listHealth(): Readonly<Record<string, ProviderHealthEntry>>;
  /** Return the registered providers' identities (id + kind) without upstream I/O. */
  listProviders(): readonly ProviderDescriptor[];
  /**
   * Replace the selects the envelopes carry as `projections` (the registry's `setProjections`).
   * Building a UI manifest sets them from its config pages, so every manifest build wires them.
   */
  setProjections(selects: ReadonlyMap<string, ProviderSelects>): void;
}

export interface AppDeps {
  config: DeckConfig;
  providers: ProviderReader;
  logger: Logger;
  /** Started module host: mounts module routes and contributes `/api/health.modules`. */
  modules?: Pick<ModuleHost, "mount" | "health" | "rootPaths">;
  /** The resolved UI manifest served at `/api/ui`, built once at boot. */
  ui?: UiManifest;
  /**
   * What to serve now, read per request: the config and UI manifest a `ui` hot reload swaps.
   * When given, it takes the place of `config` and `ui` for `/api/config`, `/api/ui` and the
   * page's boot object.
   */
  live?: () => LiveUi;
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

/**
 * A file's text, kept while the file's mtime is unchanged: one `stat` per call, and a re-read
 * when the file changes (a rebuilt web dist). `undefined` while it does not exist.
 */
function cachedText(path: string): () => Promise<string | undefined> {
  let cached: { mtimeMs: number; text: string } | undefined;
  return async () => {
    const mtimeMs = await stat(path).then((stats) => stats.mtimeMs, () => undefined);
    if (mtimeMs === undefined) return (cached = undefined);
    if (cached?.mtimeMs !== mtimeMs) {
      const text = await readFile(path, "utf8").catch(() => undefined);
      cached = text === undefined ? undefined : { mtimeMs, text };
    }
    return cached?.text;
  };
}

export function apiError(
  context: Context,
  status: number,
  error: string,
  code?: string,
): Response {
  const body: ApiError = apiErrorBody(error, code);
  return context.json(body, status as 400 | 403 | 404 | 422 | 500);
}

/**
 * The kernel's route table (method + pattern) for these deps, without any module: what a
 * module's prefixes and root paths are checked against before the module runs.
 */
export function kernelRouteTable(deps: Omit<AppDeps, "modules">): { method: string; path: string }[] {
  return createApp(deps).routes.map(({ method, path }) => ({ method, path }));
}

/**
 * independent of config and env. Module planning uses it both when config is validated and
 * at boot, so the two always agree on which modules run. The handlers are never called.
 */
export function planningRouteTable(): { method: string; path: string }[] {
  const inert = () => {
    throw new Error("planning route table: handler called");
  };
  return kernelRouteTable({
    config: { schemaVersion: 2, estate: { name: "planning" } },
    providers: { read: inert, count: () => 0, listHealth: () => ({}), listProviders: () => [], setProjections: () => {} },
    logger: { info: inert, warn: inert, error: inert } as unknown as Logger,
  });
}

export { RESERVED_ROOT_PATHS } from "./reserved-paths.js";

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  const startedAtMs = deps.startedAtMs ?? Date.now();
  const staticUi = deps.ui === undefined ? undefined : { config: deps.config, ui: deps.ui, etag: etagOf(deps.ui) };
  const current = (): { config: DeckConfig; ui?: UiManifest; etag?: string } =>
    deps.live?.() ?? staticUi ?? { config: deps.config };

  app.use("*", requestLogger(deps.logger));

  app.get("/api/config", (context) => context.json(current().config));

  app.get("/api/ui", (context) => {
    const { ui, etag } = current();
    if (ui === undefined || etag === undefined) {
      return apiError(context, 404, "No UI manifest was resolved for this server", "UI_MANIFEST_UNAVAILABLE");
    }
    // Revalidated on every read, so a reloaded manifest is seen at once and an unchanged one costs a 304.
    context.header("ETag", etag);
    context.header("Cache-Control", "no-cache");
    if (etagMatches(context.req.header("If-None-Match"), etag)) return context.body(null, 304);
    return context.json(ui);
  });

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
    const modules = deps.modules?.health() ?? { modules: {}, legacy: {} };
    const response: HealthResponse = {
      status: Object.values(providers).some((entry) => !entry.ok) ? "degraded" : "ok",
      uptimeMs: Date.now() - startedAtMs,
      providerCount: deps.providers.count(),
      providers,
      ...modules.legacy,
      modules: modules.modules,
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

  // Module routes (/api/m/<id>, declared legacy aliases and root paths): same placement
  // contract, after the built-in feature routes and before the static/SPA fallback.
  deps.modules?.mount(app, { reservedRootPaths: RESERVED_ROOT_PATHS });

  if (deps.webDistDir !== undefined) {
    // Root paths outside /api that are never rewritten to the SPA shell, so a disabled
    // module's root path 404s instead of serving index.html.
    const reserved = new Set([...RESERVED_ROOT_PATHS, ...(deps.modules?.rootPaths() ?? [])]);
    const serveStatic = lazyServeStatic({ root: deps.webDistDir });
    // The page itself is never served as a file: the fallback below writes the boot object in.
    app.use("/*", async (context, next) =>
      context.req.path === "/" || context.req.path === "/index.html" ? next() : serveStatic(context, next),
    );
    const indexTemplate = cachedText(join(deps.webDistDir, "index.html"));
    app.get("/*", async (context, next) => {
      // Reserved root paths (a disabled module's, say) must 404, not serve the SPA shell.
      if (context.req.path.startsWith("/api/") || reserved.has(context.req.path)) return next();
      const template = await indexTemplate();
      if (template === undefined) return next();
      // Rendered per request from the current manifest and config: it carries their brand.
      context.header("Cache-Control", "no-cache");
      const { ui, config } = current();
      return context.html(renderIndexHtml(template, deckBootOf(ui, config)));
    });
  }

  return app;
}
