import { POLL_DEFAULTS } from "@deck/contract";
import type { ProviderEnvelope } from "@deck/contract";
import type { DeckConfig } from "@deck/server";
import { pagePathProblem, type UiManifest } from "@deck/module-sdk";

/** A non-2xx answer to a data request; `status` is the HTTP status. */
export class HttpStatusError extends Error {
  constructor(
    readonly url: string,
    readonly status: number,
  ) {
    super(`GET ${url} → ${status}`);
    this.name = "HttpStatusError";
  }
}

/** A 2xx answer whose body is not JSON, or not the document the endpoint serves. */
export class DecodeError extends Error {
  constructor(
    readonly url: string,
    reason = "response is not JSON",
  ) {
    super(`GET ${url}: ${reason}`);
    this.name = "DecodeError";
  }
}

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, {
    method: "GET",
    headers: { Accept: "application/json" },
    ...(signal === undefined ? {} : { signal }),
  });
  if (!response.ok) throw new HttpStatusError(url, response.status);
  try {
    return (await response.json()) as T;
  } catch {
    throw new DecodeError(url);
  }
}

export const CONFIG_URL = "/api/config";
export const UI_MANIFEST_URL = "/api/ui";

export const queryKeys = {
  config: ["config"] as const,
  uiManifest: ["ui"] as const,
  provider: (id: string) => ["provider", id] as const,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether a decoded body has the shape of an estate config document deck can model. */
export function isDeckConfigShape(value: unknown): value is DeckConfig {
  return (
    isRecord(value) &&
    value.schemaVersion === 2 &&
    isRecord(value.estate) &&
    typeof value.estate.name === "string" &&
    (value.hosts === undefined || Array.isArray(value.hosts)) &&
    (value.services === undefined || Array.isArray(value.services))
  );
}

/**
 * The estate config, fixed for the life of the server process: read once per page load. A
 * body that is not a config document is a decode failure, checked before it is cached, so a
 * malformed answer is asked again like any other failed read.
 */
export const configQuery = {
  queryKey: queryKeys.config,
  queryFn: async ({ signal }: { signal?: AbortSignal }): Promise<DeckConfig> => {
    const body = await getJson<unknown>(CONFIG_URL, signal);
    if (!isDeckConfigShape(body)) throw new DecodeError(CONFIG_URL, "response is not an estate config document");
    return body;
  },
  staleTime: Infinity,
};

/** The UI manifest could not be read: a settled answer, asked again after one poll interval. */
export interface UiManifestUnavailable {
  readonly unavailable: true;
  readonly message: string;
}

export type UiManifestAnswer = UiManifest | UiManifestUnavailable;

export function isUiManifestUnavailable(answer: UiManifestAnswer | undefined): answer is UiManifestUnavailable {
  return isRecord(answer) && answer.unavailable === true;
}

const isString = (value: unknown): value is string => typeof value === "string";
const isOptionalString = (value: unknown): boolean => value === undefined || isString(value);

/** Why an entry of a manifest list is malformed, or null; `at` names the list. */
function listProblem(value: unknown, at: string, entryProblem: (entry: Record<string, unknown>) => boolean): string | null {
  if (value === undefined) return null;
  if (!Array.isArray(value)) return `${at} is not a list`;
  const index = value.findIndex((entry) => !isRecord(entry) || entryProblem(entry));
  return index === -1 ? null : `${at}[${index}] is malformed`;
}

/**
 * Why a decoded body is not a UI manifest the shell can render from, or null. The shell
 * fields are checked entry by entry, so a malformed document takes the "unavailable" path
 * (the registry fallback, asked again each poll interval) instead of being cached. Fields an
 * older server does not send (`brand`, `home`, `navGroups`, `disabledPages`) may be absent.
 */
export function uiManifestProblem(body: unknown): string | null {
  if (!isRecord(body)) return "not an object";
  if (!Array.isArray(body.providers)) return "providers is not a list";
  if (body.brand !== undefined && !(isRecord(body.brand) && isString(body.brand.title))) return "brand is malformed";
  if (body.home !== undefined && body.home !== null && !(isRecord(body.home) && isString(body.home.page) && isString(body.home.path))) return "home is malformed";
  return (
    listProblem(body.providers, "providers", (p) => !isString(p.id) || !isString(p.kind)) ??
    listProblem(body.navGroups, "navGroups", (g) => !isString(g.id) || !isString(g.label) || !isOptionalString(g.icon)) ??
    listProblem(
      body.nav,
      "nav",
      (n) =>
        !isString(n.id) || !isString(n.slot) || !isString(n.group) || typeof n.order !== "number" ||
        !isOptionalString(n.page) || !isOptionalString(n.href) || !isOptionalString(n.label) || !isOptionalString(n.icon),
    ) ??
    listProblem(
      body.extensions,
      "extensions",
      (e) => !isString(e.id) || !isString(e.kind) || !isString(e.slot) || typeof e.order !== "number",
    ) ??
    listProblem(
      body.modules,
      "modules",
      // `enabledBy` is only a hint: its readers parse it leniently, so it never rejects the manifest.
      (m) => !isString(m.id) || typeof m.enabled !== "boolean" || !isOptionalString(m.reason),
    ) ??
    listProblem(
      body.disabledPages,
      "disabledPages",
      (p) => !isString(p.id) || !isString(p.module) || !isString(p.path) || !isString(p.title) || !isOptionalString(p.icon),
    )
  );
}

/**
 * The manifest without the disabled pages the web router could not compile (the server leaves
 * them out too; this guards against an older or foreign server): one bad path must not take
 * down routing for every other page.
 */
function withRoutableDisabledPages(manifest: UiManifest): UiManifest {
  if (manifest.disabledPages === undefined) return manifest;
  const routable = manifest.disabledPages.filter((page) => {
    const problem = pagePathProblem(page.path, `disabled page "${page.id}"`, []);
    if (problem !== null) console.warn(`[deck] ${problem}; it is not routed`);
    return problem === null;
  });
  return routable.length === manifest.disabledPages.length ? manifest : { ...manifest, disabledPages: routable };
}

/**
 * The resolved UI manifest, fixed for the life of the server process. A failed read settles
 * as "unavailable" rather than an error, so readers keep a settled answer while it is asked
 * again (once per poll interval) instead of flashing back to loading; it leaves one warning
 * per failed read.
 */
export const uiManifestQuery = {
  queryKey: queryKeys.uiManifest,
  queryFn: async ({ signal }: { signal?: AbortSignal }): Promise<UiManifestAnswer> => {
    try {
      const body = await getJson<unknown>(UI_MANIFEST_URL, signal);
      const problem = uiManifestProblem(body);
      if (problem !== null) throw new DecodeError(UI_MANIFEST_URL, `response is not a UI manifest: ${problem}`);
      return withRoutableDisabledPages(body as UiManifest);
    } catch (error) {
      if (signal?.aborted) throw error;
      console.warn("[deck] UI manifest unavailable; falling back to polling every provider", error);
      return { unavailable: true, message: error instanceof Error ? error.message : String(error) };
    }
  },
  staleTime: (query: { state: { data?: UiManifestAnswer } }) =>
    isUiManifestUnavailable(query.state.data) ? POLL_DEFAULTS.pollIntervalMs : Infinity,
};

/**
 * One provider's envelope, or `null` when the provider is not registered (404) or cannot be
 * read: both render as "not configured", never as an error state.
 *
 * Freshness is one poll interval: a reader that joins within it reuses the shared result,
 * and an envelope nobody has read for longer is dropped, so the next reader starts from the
 * loading state rather than an arbitrarily old envelope.
 */
export function providerQuery<T>(id: string, intervalMs: number = POLL_DEFAULTS.pollIntervalMs) {
  const url = `/api/providers/${encodeURIComponent(id)}`;
  return {
    queryKey: queryKeys.provider(id),
    queryFn: async ({ signal }: { signal?: AbortSignal }): Promise<ProviderEnvelope<T> | null> => {
      try {
        return await getJson<ProviderEnvelope<T>>(url, signal);
      } catch (error) {
        // An abort (the last reader went away) is not a failure worth reporting.
        if (signal?.aborted) throw error;
        // A refusal (404 for an unregistered provider) is an answer; a transport or decode
        // failure is not, so it leaves a breadcrumb for field debugging.
        if (!(error instanceof HttpStatusError)) console.warn(`[deck] request failed: ${url}`, error);
        return null;
      }
    },
    staleTime: intervalMs,
    gcTime: intervalMs,
  };
}
