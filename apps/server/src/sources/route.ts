/**
 * Read-only HTTP route surface for the sources capability (05-http-routes.md).
 *
 * The single exported function `registerSourceRoutes(app, deps)` adds exactly four `GET`
 * routes — tree, file, raw, search — and no others. Every route is `GET` (REQ-RO-01): there
 * is no `app.post/put/patch/delete` anywhere in this file. Handlers gate on `deps.sources`
 * (capability off ⇒ 404) and the known-id gate, then delegate to the per-source
 * `SourceStore`, whose methods route every path through `confine.ts` (REQ-SEC-02). The
 * shared failure boundary maps any thrown `SourceFailure` to a typed `ApiError` via
 * `SOURCE_HTTP_STATUS` and logs it with source id + failure kind only (REQ-OBS-02) — never a
 * credential, an upstream message, the attempted absolute path, or a stack trace.
 *
 * This module COMPOSES pieces defined elsewhere; it declares no wire type, store method, or
 * error code. All code is TypeScript, ESM with `.js` import specifiers.
 */

import type { Context, Hono } from "hono";

import { apiError, type AppDeps } from "../server/app.js";
import { SourceFailure, SOURCE_MESSAGES, normalizeSourceFailure } from "./errors.js";
import { logSourceFailure } from "./events.js";
import type { RawReadResult, SourceStore } from "./store.js";
import type {
  FileReadResult,
  SourceManifest,
  SourceSearchResult,
} from "./tree.js";

/**
 * Resolve the store for a request, applying the capability gate (`deps.sources` absent ⇒
 * feature off) and the known-id gate. Returns the store on success, or a typed 404 Response
 * on either miss. Both misses surface as `SOURCE_NOT_FOUND` so a disabled deployment is
 * indistinguishable from an unknown id (§2.1), leaking no route topology.
 */
function resolveStore(context: Context, deps: AppDeps): SourceStore | Response {
  const id = context.req.param("id");
  const store = id === undefined ? undefined : deps.sources?.get(id);
  if (!store) {
    // No credential or path involved; SOURCE_NOT_FOUND carries only a canonical message.
    return apiError(context, 404, SOURCE_MESSAGES.SOURCE_NOT_FOUND, "SOURCE_NOT_FOUND");
  }
  return store;
}

/**
 * Run one bounded store operation behind the shared failure boundary. On success the result
 * of `run` is returned; on any throwable it is normalized to a `SourceFailure`, logged (source
 * id + failure kind only — REQ-OBS-02), and mapped to a typed `ApiError` via
 * `SOURCE_HTTP_STATUS`. The public body is `{ error, code }` — never a path, credential,
 * upstream message, or stack trace (§5.2).
 */
async function withFailureBoundary(
  context: Context,
  deps: AppDeps,
  store: SourceStore,
  run: (signal: AbortSignal) => Promise<Response>,
): Promise<Response> {
  try {
    // Thread the request's abort signal to the store so a client disconnect cancels the
    // bounded read/walk.
    return await run(context.req.raw.signal);
  } catch (error) {
    const failure: SourceFailure =
      error instanceof SourceFailure
        ? error
        : normalizeSourceFailure(error, { sourceId: store.id });
    // Server-side diagnostic: id + failure kind only. `details.attemptedPath` stays internal
    // and is NEVER echoed to the client (00 §8).
    logSourceFailure(deps.logger, {
      sourceId: store.id,
      failureKind: failure.details.failureKind ?? "read",
      code: failure.code,
    });
    const body = failure.toPublic(); // { error, code } — no path/credential/stack
    return apiError(context, failure.httpStatus, body.error, body.code);
  }
}

/** GET /api/sources/:id/tree → 200 SourceManifest (00 §2). No query params. */
async function getTree(context: Context, deps: AppDeps): Promise<Response> {
  const store = resolveStore(context, deps);
  if (store instanceof Response) return store; // 404 already produced (§2)
  return withFailureBoundary(context, deps, store, async (signal) => {
    const manifest: SourceManifest = await store.buildManifest(signal);
    return context.json(manifest); // 200; tree carries only POSIX-relative paths (00 §1)
  });
}

/** GET /api/sources/:id/file?path=<rel> → 200 FileReadResult (00 §3). */
async function getFile(context: Context, deps: AppDeps): Promise<Response> {
  const store = resolveStore(context, deps);
  if (store instanceof Response) return store;

  const relPath = context.req.query("path");
  if (!relPath) {
    // Presence/shape check only; confinement itself is the store's job (§4.5, REQ-SEC-02).
    return apiError(context, 400, "A `path` query parameter is required.", "PATH_NOT_FOUND");
  }

  return withFailureBoundary(context, deps, store, async (signal) => {
    // Confined read: `..`, absolute, or symlink-escape ⇒ store throws PATH_NOT_CONFINED (03),
    // mapped to 400 by the boundary WITHOUT echoing the attempted path (00 §8).
    const result: FileReadResult = await store.readFile(relPath, signal);
    return context.json(result); // 200; `content` omitted when truncated or binary
  });
}

/**
 * GET /api/sources/:id/raw?path=<rel> → 200 image bytes for markdown-relative images.
 * Confined + image-only + nosniff. Non-image paths are refused 400 (REQ-RO-01, §3.11).
 */
async function getRaw(context: Context, deps: AppDeps): Promise<Response> {
  const store = resolveStore(context, deps);
  if (store instanceof Response) return store;

  const relPath = context.req.query("path");
  if (!relPath) {
    return apiError(context, 400, "A `path` query parameter is required.", "PATH_NOT_FOUND");
  }

  return withFailureBoundary(context, deps, store, async (signal) => {
    const raw: RawReadResult = await store.readRaw(relPath, signal); // confined (03), bounded (00 §9)
    if (!raw.contentType.startsWith("image/")) {
      // A served asset must not be able to execute as HTML/script (REQ-RO-01, REQ-SEC-02).
      return apiError(
        context,
        400,
        "Only image assets may be served from a source root.",
        "PATH_NOT_CONFINED",
      );
    }
    // Copy into a fresh ArrayBuffer-backed view so the body type is a plain BufferSource
    // (Buffer.concat yields Uint8Array<ArrayBufferLike>, which BodyInit does not accept).
    return new Response(new Uint8Array(raw.bytes), {
      status: 200,
      headers: {
        "Content-Type": raw.contentType,
        "X-Content-Type-Options": "nosniff",
      },
    });
  });
}

/** GET /api/sources/:id/search?q=<q> → 200 SourceSearchResult (00 §4), capped at 200. */
async function getSearch(context: Context, deps: AppDeps): Promise<Response> {
  const store = resolveStore(context, deps);
  if (store instanceof Response) return store;

  const q = context.req.query("q");
  if (!q || q.trim() === "") {
    // Empty/whitespace query is a client error, not an empty result set.
    return apiError(context, 400, "A non-empty `q` query parameter is required.", "PATH_NOT_FOUND");
  }

  return withFailureBoundary(context, deps, store, async (signal) => {
    const result: SourceSearchResult = await store.search(q, signal); // scoped, capped (00 §9)
    return context.json(result); // 200; `truncated` true ⇒ web invites a narrower query
  });
}

/**
 * Register the four read-only source browsing routes on the shared Hono app. Called from
 * createApp AFTER the GET provider routes and BEFORE the static/SPA fallback (01 §2.2), so
 * /api/sources/* resolves as API. Handlers gate on deps.sources (§2) and delegate to the
 * per-source SourceStore; every route is GET (REQ-RO-01, §6).
 */
export function registerSourceRoutes(app: Hono, deps: AppDeps): void {
  app.get("/api/sources/:id/tree", (context) => getTree(context, deps));
  app.get("/api/sources/:id/file", (context) => getFile(context, deps));
  app.get("/api/sources/:id/raw", (context) => getRaw(context, deps));
  app.get("/api/sources/:id/search", (context) => getSearch(context, deps));
}
