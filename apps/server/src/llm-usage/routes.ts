/**
 * HTTP surface for LLM usage:
 *
 * - `GET /api/llm-usage`: the current response; marks a viewer present, which wakes a
 *   paused collector. `enabled: false` when the config has no `llmUsage` section.
 * - `GET /api/llm-usage/refresh`: the same after an immediate poll (5s debounce).
 * - `POST /api/llm-usage/ingest`: the Claude statusLine push. Registered only when the
 *   bearer token env var is set, so an unconfigured deployment has no write surface.
 *   The bearer is compared in constant time; the body is capped at 2 MB.
 */

import { createHash, timingSafeEqual } from "node:crypto";

import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";

import { apiError, type AppDeps } from "../server/app.js";
import { disabledResponse, type LlmUsageCollector } from "./collector.js";

export const INGEST_MAX_BYTES = 2 * 1024 * 1024;

export interface LlmUsageDeps {
  collector: LlmUsageCollector;
  /** The ingest bearer token's value, resolved from env at boot; null leaves ingest unregistered. */
  ingestToken: string | null;
}

const digest = (value: string) => createHash("sha256").update(value).digest();

/** Constant-time bearer check; hashing first equalizes lengths for `timingSafeEqual`. */
export function bearerMatches(header: string | undefined, token: string): boolean {
  const presented = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  return timingSafeEqual(digest(presented), digest(token)) && presented.length > 0;
}

export function registerLlmUsageRoutes(app: Hono, deps: AppDeps): void {
  const usage = deps.llmUsage;

  app.get("/api/llm-usage", async (context) =>
    context.json(usage ? await usage.collector.read() : disabledResponse(Date.now())));

  app.get("/api/llm-usage/refresh", async (context) =>
    context.json(usage ? await usage.collector.refresh() : disabledResponse(Date.now())));

  if (!usage?.ingestToken) return;
  const token = usage.ingestToken;
  app.post(
    "/api/llm-usage/ingest",
    async (context, next) => {
      if (!bearerMatches(context.req.header("authorization"), token)) {
        return apiError(context, 401, "Unauthorized", "UNAUTHORIZED");
      }
      return next();
    },
    bodyLimit({
      maxSize: INGEST_MAX_BYTES,
      onError: (context: Context) => apiError(context, 413, "Payload too large", "PAYLOAD_TOO_LARGE"),
    }),
    async (context) => {
      let payload: unknown;
      try {
        payload = JSON.parse(await context.req.text());
      } catch {
        return apiError(context, 400, "Body must be JSON", "BAD_JSON");
      }
      usage.collector.ingestStatusline(payload);
      return context.body(null, 204);
    },
  );
}
