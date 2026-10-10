import { POLL_DEFAULTS } from "@deck/contract";
import type { ProviderEnvelope, SnapshotProviderResult } from "@deck/contract";
import type { DeckConfig } from "@deck/server";
import {
  configQuery,
  DecodeError,
  getQueryClient,
  HttpStatusError,
  isDeckConfigShape,
  isProviderPollable,
} from "@/data/index.js";
import type { InventoryModel } from "./model.js";
import { buildInventoryModel } from "./model.js";

/** Fixed feature endpoints. They are not configurable by page or fragment code. */
export const INVENTORY_ENDPOINTS = Object.freeze({
  config: "/api/config",
  snapshot: "/api/providers/snapshot",
} as const);

/** Cold-start envelope used only until the first aggregate HTTP poll commits. */
export const INITIAL_SNAPSHOT_ENVELOPE: ProviderEnvelope<null> = Object.freeze({
  id: "snapshot",
  kind: "snapshot",
  freshness: Object.freeze({
    state: "pending",
    observedAt: null,
    ageMs: null,
    ttlMs: null,
  }),
  data: null,
  error: null,
});

/**
 * Distinguishes absence, cold start, first-read failure, retained data, and request failure.
 * Owned by this module; `model.ts` imports it via the compatibility
 * adapter, which re-exports this type from here.
 */
export type SnapshotClientState =
  | { status: "not-configured" }
  | { status: "pending"; envelope: ProviderEnvelope<null> }
  | { status: "failed-empty"; envelope: ProviderEnvelope<null> }
  | { status: "available"; envelope: ProviderEnvelope<SnapshotProviderResult> }
  | { status: "request-error"; message: string };

/** One atomically committed config/snapshot browser generation. */
export interface InventoryData {
  config: DeckConfig | null;
  configError: string | null;
  snapshot: SnapshotClientState;
  model: InventoryModel | null;
  loading: boolean;
}

/** Existing inventory data plus browser-local acceptance metadata. */
export interface InventoryGeneration extends InventoryData {
  /**
   * Monotonic id of a complete aggregate response accepted by this browser
   * singleton. Zero means no aggregate response has yet been accepted.
   */
  readonly refreshGeneration: number;
  /**
   * Sanitized current aggregate request/decode failure, or null after the
   * latest complete response. Never contains a response body or endpoint value.
   */
  readonly transientError: string | null;
}

// ---------------------------------------------------------------------------
// Feature-private HTTP and decode contracts (moved intact from the former hook).
// ---------------------------------------------------------------------------

/** Stable client failure classes used for tests and safe display messages. */
type InventoryRequestErrorCode =
  | "CONFIG_HTTP"
  | "CONFIG_REQUEST"
  | "CONFIG_DECODE"
  | "SNAPSHOT_HTTP"
  | "SNAPSHOT_REQUEST"
  | "SNAPSHOT_DECODE";

/** Canonical safe client message for each fixed-endpoint failure class. */
const INVENTORY_REQUEST_MESSAGES: Readonly<
  Record<InventoryRequestErrorCode, string>
> = {
  CONFIG_HTTP: "Config request returned HTTP <status>; check the deck server.",
  CONFIG_REQUEST: "Config request failed; check the deck server connection.",
  CONFIG_DECODE: "Config response is invalid; check the deck server.",
  SNAPSHOT_HTTP: "Snapshot request returned HTTP <status>; check the deck server.",
  SNAPSHOT_REQUEST: "Snapshot request failed; check the deck server connection.",
  SNAPSHOT_DECODE: "Snapshot response is invalid; check the deck server.",
};

/**
 * Fixed sanitized message for an internal refresh failure that is neither an
 * HTTP/network/decode class nor an accepted generation — an unexpected model
 * construction throw or a generation-counter overflow. It never carries the
 * thrown message or any response content.
 */
const INVENTORY_INTERNAL_REFRESH_MESSAGE =
  "Inventory refresh could not be applied; check the deck server.";

/** Internal endpoint failure. Messages mention only fixed endpoint and status/class. */
class InventoryRequestError extends Error {
  readonly name = "InventoryRequestError";

  constructor(
    readonly code: InventoryRequestErrorCode,
    message: string,
    readonly httpStatus?: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

interface ConfigFetchResult {
  config: DeckConfig | null;
  error: string | null;
}

const REQUEST_INIT: RequestInit = {
  method: "GET",
  headers: { Accept: "application/json" },
};

const FRESHNESS_STATES: ReadonlySet<string> = new Set([
  "fresh",
  "stale",
  "unreachable",
  "static",
  "pending",
]);

/** Substitute the single `<status>` token with a decimal numeric HTTP status. */
function statusMessage(code: InventoryRequestErrorCode, status: number): string {
  return INVENTORY_REQUEST_MESSAGES[code].replace("<status>", String(status));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True for an aborted signal or an AbortError so control flow is never a visible error. */
function isAbortLike(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true;
  return error instanceof Error && error.name === "AbortError";
}

/** Recursively freeze an accepted JSON response before publication. */
function deepFreeze<T>(value: T, seen: WeakSet<object> = new WeakSet()): T {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return value;
  seen.add(value);
  for (const key of Object.keys(value)) {
    deepFreeze((value as Record<string, unknown>)[key], seen);
  }
  return Object.freeze(value);
}

/** Decode a config document sufficiently to prevent a non-object response entering the model. */
function decodeConfig(value: unknown): DeckConfig {
  if (isDeckConfigShape(value)) return value;
  throw new InventoryRequestError(
    "CONFIG_DECODE",
    INVENTORY_REQUEST_MESSAGES.CONFIG_DECODE,
  );
}

/** Decode the provider envelope and required snapshot-result surface. */
function decodeSnapshotEnvelope(
  value: unknown,
): ProviderEnvelope<SnapshotProviderResult | null> {
  if (
    !isObject(value) ||
    value.id !== "snapshot" ||
    value.kind !== "snapshot" ||
    !isObject(value.freshness) ||
    typeof value.freshness.state !== "string" ||
    !FRESHNESS_STATES.has(value.freshness.state) ||
    !(value.error === null || (isObject(value.error) && typeof value.error.message === "string"))
  ) {
    throw new InventoryRequestError(
      "SNAPSHOT_DECODE",
      INVENTORY_REQUEST_MESSAGES.SNAPSHOT_DECODE,
    );
  }

  const data = value.data;
  if (data !== null) {
    if (
      !isObject(data) ||
      !isObject(data.snapshot) ||
      !Array.isArray(data.findings) ||
      !isObject(data.hostStates) ||
      typeof data.lastReadAt !== "string" ||
      !(
        data.readError === null ||
        (isObject(data.readError) &&
          typeof data.readError.code === "string" &&
          typeof data.readError.message === "string")
      )
    ) {
      throw new InventoryRequestError(
        "SNAPSHOT_DECODE",
        INVENTORY_REQUEST_MESSAGES.SNAPSHOT_DECODE,
      );
    }
  }

  // Retain the exact decoded object without reconstructing or narrowing snapshot.
  return value as unknown as ProviderEnvelope<SnapshotProviderResult | null>;
}

/**
 * Read the config through the shared query cache, so every poll and every other reader share
 * one `/api/config` request per page load. A failed read is not cached. While other readers
 * hold the shared query, it re-asks on its own cadence and this poll reports the failure
 * without forcing a refetch (which would flicker every reader back to loading); with no other
 * reader, this poll asks again itself. Expected failures are classified, never thrown; an
 * abort of this poll is rethrown.
 */
async function fetchConfig(signal: AbortSignal): Promise<ConfigFetchResult> {
  try {
    const body = await abortable(readSharedConfig(), signal);
    // A private, frozen copy: the cached document stays the shared original.
    return { config: deepFreeze(decodeConfig(structuredClone(body))), error: null };
  } catch (error) {
    if (isAbortLike(error, signal)) throw error;
    if (error instanceof HttpStatusError) {
      return { config: null, error: statusMessage("CONFIG_HTTP", error.status) };
    }
    if (error instanceof DecodeError) {
      return { config: null, error: INVENTORY_REQUEST_MESSAGES.CONFIG_DECODE };
    }
    if (error instanceof InventoryRequestError) {
      return { config: null, error: error.message };
    }
    return { config: null, error: INVENTORY_REQUEST_MESSAGES.CONFIG_REQUEST };
  }
}

/** The cached config, its standing failure while readers own the retry, or a fetch. */
function readSharedConfig(): Promise<unknown> {
  const client = getQueryClient();
  const state = client.getQueryState(configQuery.queryKey);
  if (state?.status === "success") return Promise.resolve(state.data);
  const observed = (client.getQueryCache().find({ queryKey: configQuery.queryKey })?.getObserversCount() ?? 0) > 0;
  if (state?.status === "error" && state.fetchStatus === "idle" && observed) return Promise.reject(state.error);
  return client.fetchQuery(configQuery);
}

/** Settle with `promise`, or reject with an AbortError as soon as `signal` aborts. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/** Fetch and classify the fixed snapshot endpoint without throwing expected failures. */
async function fetchSnapshot(signal: AbortSignal): Promise<SnapshotClientState> {
  // Skip the request entirely when no snapshot provider is registered; this is
  // the same not-configured state the 404 path yields, without the console 404.
  if (!(await isProviderPollable("snapshot"))) return { status: "not-configured" };
  try {
    const response = await fetch(INVENTORY_ENDPOINTS.snapshot, {
      ...REQUEST_INIT,
      signal,
    });
    if (response.status === 404) return { status: "not-configured" };
    if (!response.ok) {
      return {
        status: "request-error",
        message: statusMessage("SNAPSHOT_HTTP", response.status),
      };
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return {
        status: "request-error",
        message: INVENTORY_REQUEST_MESSAGES.SNAPSHOT_DECODE,
      };
    }

    let envelope: ProviderEnvelope<SnapshotProviderResult | null>;
    try {
      envelope = deepFreeze(decodeSnapshotEnvelope(body));
    } catch {
      return {
        status: "request-error",
        message: INVENTORY_REQUEST_MESSAGES.SNAPSHOT_DECODE,
      };
    }

    if (envelope.data === null) {
      return envelope.error === null
        ? { status: "pending", envelope: envelope as ProviderEnvelope<null> }
        : { status: "failed-empty", envelope: envelope as ProviderEnvelope<null> };
    }
    return {
      status: "available",
      envelope: envelope as ProviderEnvelope<SnapshotProviderResult>,
    };
  } catch (error) {
    if (isAbortLike(error, signal)) throw error;
    return {
      status: "request-error",
      message: INVENTORY_REQUEST_MESSAGES.SNAPSHOT_REQUEST,
    };
  }
}

// ---------------------------------------------------------------------------
// Singleton store state.
// ---------------------------------------------------------------------------

/** One live subscription. Records are unique so duplicate callbacks own separately. */
interface SubscriptionRecord {
  readonly listener: () => void;
}

/** Immutable cold-start generation; reused as the retained shell before acceptance. */
const initial: InventoryGeneration = Object.freeze({
  config: null,
  configError: null,
  snapshot: Object.freeze({
    status: "pending",
    envelope: INITIAL_SNAPSHOT_ENVELOPE,
  }),
  model: null,
  loading: true,
  refreshGeneration: 0,
  transientError: null,
});

let current: InventoryGeneration = initial;
const subscriptions = new Set<SubscriptionRecord>();
let activeInterval: number | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let activeController: AbortController | null = null;
let requestToken = 0;

/** Surface a listener exception without disrupting the notify loop or store data. */
function surfaceListenerError(error: unknown): void {
  const report = (globalThis as { reportError?: (value: unknown) => void })
    .reportError;
  if (typeof report === "function") {
    report(error);
    return;
  }
  setTimeout(() => {
    throw error;
  }, 0);
}

/** Notify every currently-registered subscriber from a stable snapshot. */
function notify(): void {
  for (const record of [...subscriptions]) {
    try {
      record.listener();
    } catch (error) {
      surfaceListenerError(error);
    }
  }
}

/**
 * Retain the prior complete generation and publish only a changed sanitized
 * `transientError`. At generation zero this records browser request failure with
 * no retained data (null config/model, initial pending envelope, `loading:false`).
 */
function publishTransientFailure(message: string): void {
  if (current.transientError === message && current.loading === false) return;

  current =
    current.refreshGeneration > 0
      ? Object.freeze({
          config: current.config,
          configError: current.configError,
          snapshot: current.snapshot,
          model: current.model,
          loading: false,
          refreshGeneration: current.refreshGeneration,
          transientError: message,
        })
      : Object.freeze({
          config: null,
          configError: null,
          snapshot: current.snapshot,
          model: null,
          loading: false,
          refreshGeneration: 0,
          transientError: message,
        });
  notify();
}

/**
 * Atomically accept one complete aggregate response: build the model once, swap
 * the frozen generation in a single statement, then notify.
 */
function acceptGeneration(
  config: DeckConfig,
  snapshot: SnapshotClientState,
): void {
  let model: InventoryModel;
  try {
    model = buildInventoryModel(config, snapshot);
  } catch {
    // A valid decode that still throws in model construction is an internal
    // refresh failure, not an accepted generation: retain the prior bundle.
    publishTransientFailure(INVENTORY_INTERNAL_REFRESH_MESSAGE);
    return;
  }

  if (current.refreshGeneration >= Number.MAX_SAFE_INTEGER) {
    publishTransientFailure(INVENTORY_INTERNAL_REFRESH_MESSAGE);
    return;
  }

  current = Object.freeze({
    config,
    configError: null,
    snapshot,
    model,
    loading: false,
    refreshGeneration: current.refreshGeneration + 1,
    transientError: null,
  });
  notify();
}

/**
 * Classify one settled aggregate pair and publish exactly one transition:
 * a complete acceptance, or a retained failure with a sanitized message.
 * Config failure takes precedence over snapshot failure.
 */
function commit(
  configResult: ConfigFetchResult,
  snapshot: SnapshotClientState,
): void {
  const transient =
    configResult.error !== null
      ? configResult.error
      : snapshot.status === "request-error"
        ? snapshot.message
        : null;

  if (transient !== null || configResult.config === null) {
    publishTransientFailure(transient ?? INVENTORY_INTERNAL_REFRESH_MESSAGE);
    return;
  }
  acceptGeneration(configResult.config, snapshot);
}

/**
 * One cancellable aggregate refresh. A request token distinct from
 * `refreshGeneration` rejects aborted, superseded, and out-of-order completions.
 */
async function poll(): Promise<void> {
  activeController?.abort();
  const myRequest = ++requestToken;
  const controller = new AbortController();
  activeController = controller;
  const { signal } = controller;

  let configResult: ConfigFetchResult;
  let snapshotState: SnapshotClientState;
  try {
    [configResult, snapshotState] = await Promise.all([
      fetchConfig(signal),
      fetchSnapshot(signal),
    ]);
  } catch (error) {
    // Aborted work is control flow; it commits nothing and shows no error.
    if (isAbortLike(error, signal)) return;
    configResult = {
      config: null,
      error: INVENTORY_REQUEST_MESSAGES.CONFIG_REQUEST,
    };
    snapshotState = {
      status: "request-error",
      message: INVENTORY_REQUEST_MESSAGES.SNAPSHOT_REQUEST,
    };
  }

  // Publish only if this exact request still owns the live poll.
  if (
    subscriptions.size === 0 ||
    signal.aborted ||
    myRequest !== requestToken ||
    activeController !== controller
  ) {
    return;
  }

  commit(configResult, snapshotState);
}

/**
 * Return the current immutable singleton reference without starting polling.
 * Repeated calls return the same reference until the store publishes a transition.
 */
export function getInventoryGeneration(): InventoryGeneration {
  return current;
}

/**
 * Subscribe using the legacy hook interval. While subscribers are active, every
 * subscription must request the interval established by the first subscriber.
 *
 * @param listener - Synchronous invalidation callback; consumers re-read with
 * `getInventoryGeneration()`.
 * @param intervalMs - Positive finite poll interval shared by all subscribers.
 * @returns An idempotent unsubscribe function.
 * @throws {RangeError} If `intervalMs` is non-finite or not greater than zero.
 * @throws {RangeError} If another active subscriber owns a different interval.
 * @internal Feature-private; drift code must use {@link subscribeInventoryGeneration}.
 */
export function subscribeInventoryGenerationAtInterval(
  listener: () => void,
  intervalMs: number,
): () => void {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new RangeError("intervalMs must be a positive finite number.");
  }
  if (subscriptions.size > 0 && activeInterval !== intervalMs) {
    throw new RangeError(
      "Inventory store already has a different active poll interval.",
    );
  }

  const record: SubscriptionRecord = { listener };
  const wasEmpty = subscriptions.size === 0;
  subscriptions.add(record);

  if (wasEmpty) {
    activeInterval = intervalMs;
    void poll();
    timer = setInterval(() => void poll(), intervalMs);
  }

  let active = true;
  return () => {
    if (!active) return;
    active = false;
    subscriptions.delete(record);
    if (subscriptions.size === 0) {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
      activeController?.abort();
      activeController = null;
      requestToken++;
      activeInterval = null;
    }
  };
}

/**
 * Subscribe at the product-default interval. The first active subscriber starts
 * one immediate refresh and one interval; the last unsubscribe stops both.
 *
 * @param listener - Synchronous invalidation callback; consumers re-read with
 * `getInventoryGeneration()`.
 * @returns An idempotent unsubscribe function.
 */
export function subscribeInventoryGeneration(
  listener: () => void,
): () => void {
  return subscribeInventoryGenerationAtInterval(
    listener,
    POLL_DEFAULTS.pollIntervalMs,
  );
}
