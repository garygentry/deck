/**
 * HTTP surface for LLM usage, on the module's sub-app (mounted at `/api/m/llm-usage` and
 * the legacy `/api/llm-usage`):
 *
 * - `GET /`: the current response; marks a viewer present, which wakes a paused
 *   collector. `enabled: false` when the config has no `modules.llm-usage` section.
 * - `GET /refresh`: the same after an immediate poll (5s debounce).
 * - `POST /ingest`: the Claude statusLine push. Registered only when the bearer token env
 *   var is set, so an unconfigured deployment has no write surface. The bearer is compared
 *   in constant time; the body is capped at 2 MB.
 */

import { createHash, timingSafeEqual } from "node:crypto";

import { apiErrorBody } from "@deck/module-sdk";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";

import { disabledResponse, type LlmUsageCollector } from "./collector.js";

export const INGEST_MAX_BYTES = 2 * 1024 * 1024;

export interface LlmUsageDeps {
  collector: LlmUsageCollector;
  /** The ingest bearer token's value, resolved from env at init; null leaves ingest unregistered. */
  ingestToken: string | null;
}

const digest = (value: string) => createHash("sha256").update(value).digest();

/** Constant-time bearer check; hashing first equalizes lengths for `timingSafeEqual`. */
export function bearerMatches(header: string | undefined, token: string): boolean {
  const presented = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  return timingSafeEqual(digest(presented), digest(token)) && presented.length > 0;
}

const apiError = (context: Context, status: 400 | 401 | 413, error: string, code: string) =>
  context.json(apiErrorBody(error, code), status);

/** Register the routes; `usage` is null when the section is absent (reads report `enabled: false`). */
export function registerLlmUsageRoutes(http: Hono, usage: LlmUsageDeps | null, now: () => number): void {
  http.get("/", async (context) =>
    context.json(usage ? await usage.collector.read() : disabledResponse(now())));

  http.get("/refresh", async (context) =>
    context.json(usage ? await usage.collector.refresh() : disabledResponse(now())));

  if (!usage?.ingestToken) return;
  const token = usage.ingestToken;
  http.post(
    "/ingest",
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
