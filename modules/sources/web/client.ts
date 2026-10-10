/**
 * HTTP client for the sources browsing feature (Docs + Configs pages, owned-configs fragment).
 *
 * Owns all HTTP for the feature. Every wrapper returns a **discriminated value** — the parsed
 * payload on success, or a typed {@link SourceClientError} on any expected failure (network
 * drop, non-2xx, confinement rejection, unparseable body). A failure is **never thrown** to a
 * UI caller (the `SnapshotClientState` / `RunRefusal` convention in the existing web features):
 * components branch exhaustively, the UI never hangs, and no stack trace or attempted path
 * reaches the DOM.
 *
 * The wire types are imported from the module's server half (`../server/types.ts`) as
 * `import type` — never from `@deck/schema` directly. This
 * module holds NO knowledge of the browse store; `sources-store.ts` and its store-writing
 * wrappers land in a later item and compose these primitives.
 *
 * Every request is a GET: no wrapper here issues POST/PUT/PATCH/DELETE.
 */

import type { ProviderEnvelope } from "@deck/contract";
import type { DeckConfig } from "@deck/server";
import type { FileReadResult, SourceManifest, SourceSearchResult } from "../server/types.js";

import { setFile, setManifest, setSearch } from "./sources-store.js";

/**
 * One declared source (`DeckConfig.sources[]`). `Source` is not re-exported by the `@deck/server`
 * contract barrel; per 06 (Warnings) it is derived from `DeckConfig` here rather than imported
 * from `@deck/schema` (which this feature must never do).
 */
export type Source = NonNullable<DeckConfig["sources"]>[number];

/**
 * Fixed server endpoints for the sources feature (the analogue of the frozen `ACTION_ENDPOINTS`
 * in `modules/actions/web/client.ts`). Not configurable by page or component code. `:id` and
 * query values are percent-encoded here so callers pass raw ids/paths. Every endpoint is a GET.
 */
export const SOURCE_ENDPOINTS = Object.freeze({
  /** GET the provider envelope: manifest + freshness. Drives the tree and the freshness badge. */
  envelope: (id: string): string => `/api/providers/${encodeURIComponent(id)}`,
  /** GET the unwrapped manifest (same tree data, no freshness). Convenience only. */
  tree: (id: string): string => `/api/sources/${encodeURIComponent(id)}/tree`,
  /** GET one confined file (1 MiB cap → truncated; binary → flagged). */
  file: (id: string, path: string): string =>
    `/api/sources/${encodeURIComponent(id)}/file?path=${encodeURIComponent(path)}`,
  /** Raw-bytes URL for a confined asset — used as an `<img src>` by the markdown pipeline
   *. Returned as a string, not fetched by JS (the browser fetches the img). */
  raw: (id: string, path: string): string =>
    `/api/sources/${encodeURIComponent(id)}/raw?path=${encodeURIComponent(path)}`,
  /** GET server-side name+content search (capped at 200 matches). */
  search: (id: string, q: string): string =>
    `/api/sources/${encodeURIComponent(id)}/search?q=${encodeURIComponent(q)}`,
  /** GET the merged DeckConfig; consumers read `config.sources[]`. */
  config: "/api/config",
} as const);

/**
 * The typed error a wrapper resolves to on any expected failure. Mirrors the server's
 * `SourceApiError` body (`{ error, code }`) mapped to a UI-safe shape.
 */
export interface SourceClientError {
  /** Safe canonical message (never a path/credential/stack). */
  readonly message: string;
  /** Stable code from SOURCE_ERROR_CODES, or "REQUEST" for a transport/parse failure
   *  the client itself classified (fetch rejected, non-JSON body, body === null). */
  readonly code: string;
}

/** The manifest+freshness state for one source (drives tree/empty/error/stale branching). */
export type ManifestState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly envelope: ProviderEnvelope<SourceManifest> }
  | { readonly status: "error"; readonly error: SourceClientError };

/** The read state for one selected file/document. */
export type FileState =
  | { readonly status: "idle" }
  | { readonly status: "loading"; readonly path: string }
  | { readonly status: "ready"; readonly result: FileReadResult }
  | { readonly status: "error"; readonly path: string; readonly error: SourceClientError };

/** The content-search state for the active source. */
export type SearchState =
  | { readonly status: "idle" }
  | { readonly status: "loading"; readonly query: string }
  | { readonly status: "ready"; readonly result: SourceSearchResult }
  | { readonly status: "error"; readonly query: string; readonly error: SourceClientError };

/** Shape of a non-2xx JSON error body (`SourceApiError`). */
interface ErrorBody {
  readonly error?: unknown;
  readonly code?: unknown;
}

/** A generic, path/credential-free fallback message for a failure the body did not name. */
const GENERIC_FAILURE = "The request could not be completed.";

/**
 * Narrow a wrapper's resolved value to a {@link SourceClientError}. Every success payload
 * (envelope, manifest, file, search result, config) is an object without a top-level string
 * `message`/`code` pair, so the presence of both discriminates the error branch. Callers
 * branch on this rather than a `try/catch` — the wrappers never throw.
 */
export function isSourceClientError(value: object): value is SourceClientError {
  return (
    "message" in value &&
    typeof (value as { message?: unknown }).message === "string" &&
    "code" in value &&
    typeof (value as { code?: unknown }).code === "string"
  );
}

/** Build a {@link SourceClientError} from a parsed non-2xx body, with safe fallbacks. */
function errorFromBody(body: ErrorBody | null): SourceClientError {
  const message = typeof body?.error === "string" ? body.error : GENERIC_FAILURE;
  const code = typeof body?.code === "string" ? body.code : "REQUEST";
  return { message, code };
}

/**
 * Shared never-throw JSON GET. Resolves to the parsed body on 2xx, or a {@link SourceClientError}
 * on any non-2xx / transport / parse failure. NEVER throws to the caller.
 *
 * On a non-2xx response it parses the typed `{ error, code }` body into a
 * `SourceClientError`. A missing/unparseable body — or a rejected fetch (offline, aborted) —
 * degrades to `{ message: <generic>, code: "REQUEST" }`. A 2xx body that fails to parse as JSON
 * is likewise a transport-shaped `REQUEST` failure.
 */
async function getJson<T>(
  url: string,
  signal?: AbortSignal,
): Promise<T | SourceClientError> {
  let response: Response;
  try {
    response = await fetch(url, { method: "GET", signal });
  } catch {
    // The request never reached a response (offline, DNS, or aborted before headers).
    return { message: GENERIC_FAILURE, code: "REQUEST" };
  }

  if (!response.ok) {
    let body: ErrorBody | null = null;
    try {
      body = (await response.json()) as ErrorBody;
    } catch {
      body = null;
    }
    return errorFromBody(body);
  }

  try {
    return (await response.json()) as T;
  } catch {
    // A 2xx with a non-JSON / empty body is a transport failure, never a hang.
    return { message: GENERIC_FAILURE, code: "REQUEST" };
  }
}

/**
 * Read one source's manifest+freshness envelope (`GET /api/providers/:id`). Store-independent:
 * resolves to the envelope on success or a {@link SourceClientError} on failure, without
 * touching any browse store. This is the primitive both the single-active Docs/Configs pages
 * and the multi-source owned-configs fragment build on. Never throws.
 *
 * @param id  any declared source id (not necessarily the active one).
 */
export async function fetchManifest(
  id: string,
  signal?: AbortSignal,
): Promise<ProviderEnvelope<SourceManifest> | SourceClientError> {
  return getJson<ProviderEnvelope<SourceManifest>>(SOURCE_ENDPOINTS.envelope(id), signal);
}

/**
 * Read one source's unwrapped manifest (`GET /api/sources/:id/tree`) — the same tree data as
 * {@link fetchManifest} without the freshness envelope. Convenience for callers that need only
 * the tree. Never throws.
 */
export async function fetchTree(
  id: string,
  signal?: AbortSignal,
): Promise<SourceManifest | SourceClientError> {
  return getJson<SourceManifest>(SOURCE_ENDPOINTS.tree(id), signal);
}

/**
 * Read one confined file/document (`GET /api/sources/:id/file?path=`). `truncated` / `binary`
 * are NOT errors — they arrive as a successful {@link FileReadResult} with `content` omitted
 *. Never throws.
 *
 * @param id    the source id.
 * @param path  POSIX path relative to the source root (from the selected tree node).
 */
export async function fetchFile(
  id: string,
  path: string,
  signal?: AbortSignal,
): Promise<FileReadResult | SourceClientError> {
  return getJson<FileReadResult>(SOURCE_ENDPOINTS.file(id, path), signal);
}

/**
 * Run server-side name+content search (`GET /api/sources/:id/search?q=`) for one source. An
 * empty/whitespace `query` short-circuits to an empty result without a round-trip. Never throws.
 */
export async function fetchSearch(
  id: string,
  query: string,
  signal?: AbortSignal,
): Promise<SourceSearchResult | SourceClientError> {
  if (query.trim() === "") {
    return { sourceId: id, matches: [] };
  }
  return getJson<SourceSearchResult>(SOURCE_ENDPOINTS.search(id, query), signal);
}

/**
 * Read the merged {@link DeckConfig} (`GET /api/config`). Pages read `config.sources[]` from it
 * to enumerate the declared sources of a kind (markdown-tree for Docs, file-tree for Configs).
 * Never throws.
 */
export async function fetchConfig(
  signal?: AbortSignal,
): Promise<DeckConfig | SourceClientError> {
  return getJson<DeckConfig>(SOURCE_ENDPOINTS.config, signal);
}

/**
 * Build the raw-asset URL for a confined path. Pure string builder — no fetch;
 * the browser fetches it as an `<img>` src. Re-used by `markdown.ts`'s image rewrite.
 */
export function rawAssetUrl(id: string, path: string): string {
  return SOURCE_ENDPOINTS.raw(id, path);
}

// ---------------------------------------------------------------------------
// Store-writing load wrappers. These compose the never-throw `fetch*`
// primitives with the `sources-store.ts` mutators — `client.ts` is the sole network writer.
// Each is called from a `use-source.ts` load hook and never throws; an expected failure becomes
// a typed `"error"` state, and the store's stale-response guards drop a superseded response.
// ---------------------------------------------------------------------------

/**
 * Load the active source's manifest+freshness envelope and publish it (`setManifest`). Called on
 * source selection/mount and on manual refresh. A `data:null`+`error` envelope is still a
 * successful `"ready"` state whose content discriminates to the error UI, distinct from
 * a transport `"error"`. Never throws.
 */
export async function loadManifest(id: string, signal?: AbortSignal): Promise<void> {
  setManifest(id, { status: "loading" });
  const body = await fetchManifest(id, signal);
  if (isSourceClientError(body)) {
    setManifest(id, { status: "error", error: body });
  } else {
    setManifest(id, { status: "ready", envelope: body });
  }
}

/**
 * Load one confined file/document and publish it (`setFile`). `truncated` / `binary` are NOT
 * errors — they arrive as a successful `FileReadResult` the view handles. Never throws.
 */
export async function loadFile(id: string, path: string, signal?: AbortSignal): Promise<void> {
  const body = await fetchFile(id, path, signal);
  if (isSourceClientError(body)) {
    setFile({ status: "error", path, error: body });
  } else {
    setFile({ status: "ready", result: body });
  }
}

/**
 * Run server-side content+name search for the active source and publish it (`setSearch`). An
 * empty/whitespace `query` short-circuits to `"idle"` without a round-trip. Never throws.
 */
export async function runSearch(id: string, query: string, signal?: AbortSignal): Promise<void> {
  if (query.trim() === "") {
    setSearch({ status: "idle" });
    return;
  }
  setSearch({ status: "loading", query });
  const body = await fetchSearch(id, query, signal);
  if (isSourceClientError(body)) {
    setSearch({ status: "error", query, error: body });
  } else {
    setSearch({ status: "ready", result: body });
  }
}
