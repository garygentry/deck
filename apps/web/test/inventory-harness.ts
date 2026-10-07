import { vi } from "vitest";
import type {
  Host,
  ObservedHost,
  ObservedService,
  Service,
} from "@deck/schema";
import type {
  DeckConfig,
  HostState,
  ProviderEnvelope,
  SnapshotProviderResult,
} from "@deck/server";
import type {
  InventoryData,
  SnapshotClientState,
} from "../src/features/hosts-and-services/use-inventory-data.js";
import { buildInventoryModel } from "../src/features/hosts-and-services/model.js";
import { resetProvidersIndexCache } from "../src/shell/providers-index.js";
import { mount } from "./support/render.js";

// ---------------------------------------------------------------------------
// Real-DOM (jsdom) test environment.
//
// Dependents run under `// @vitest-environment jsdom`, so `document`/`window`
// are real jsdom globals from module load onward (React DOM decides whether it
// can use the DOM when it is first imported). `installEnv` hands each test a
// fresh container attached to `document.body` (so focus and bubbling events
// reach React's root listener), a small `document` view whose `activeElement`
// reports `null` when nothing is focused, and a `window` view that can count
// the listeners components register through `window.addEventListener`.
// ---------------------------------------------------------------------------

/** A real DOM node (kept as a named alias for the dependents' type imports). */
export type TestNode = Node;
/** A real DOM text node. */
export type TestText = Text;
/** A real DOM element. */
export type TestElement = HTMLElement;

/**
 * Thin view over the real `document`. `activeElement` is `null` when focus
 * rests on `<body>` (jsdom's "nothing focused"), and assigning `null` blurs the
 * currently focused element. `clicks` records every element that received a
 * click (in dispatch order) since `installEnv`.
 */
export class TestDocument {
  readonly clicks: TestElement[] = [];

  get activeElement(): TestElement | null {
    const active = document.activeElement;
    if (active === null || active === document.body) return null;
    return active as TestElement;
  }
  set activeElement(value: TestElement | null) {
    if (value === null) {
      (document.activeElement as HTMLElement | null)?.blur?.();
    } else {
      value.focus();
    }
  }
  createElement = (name: string): TestElement => document.createElement(name);
  createElementNS = (namespace: string, name: string): Element =>
    document.createElementNS(namespace, name);
  createTextNode = (value: string): TestText => document.createTextNode(value);
}

export interface WindowStub {
  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ): void;
  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | EventListenerOptions,
  ): void;
  dispatchEvent(event: Event): boolean;
  /** Listeners currently registered on the real `window` through the harness. */
  listenerCount(type: string): number;
}

export interface Env {
  root: TestElement;
  doc: TestDocument;
  win: WindowStub;
}

/** The container handed out by the most recent `installEnv` (torn down by the next). */
let installedRoot: TestElement | null = null;

/**
 * Unmount any React tree still mounted (through `test/support/render.ts`) in the
 * previously installed container. The DOM and `window` are now shared across a
 * file's tests, so a tree a test left mounted would otherwise keep its window
 * listeners and timers alive into the next test.
 */
function teardownInstalledRoot(): void {
  if (installedRoot === null) return;
  const previous = installedRoot;
  installedRoot = null;
  mount(null, previous);
  previous.remove();
}

const captureOf = (options?: boolean | EventListenerOptions): boolean =>
  typeof options === "boolean" ? options : options?.capture === true;

/**
 * Prepare a fresh DOM for one test: clear `document.body`, attach a new
 * container `div` to it, and track `window` listener registrations so
 * `win.listenerCount(type)` reports the live count. `resetInventoryTestEnv`
 * (via `vi.restoreAllMocks`) removes the tracking wrappers.
 */
export function installEnv(): Env {
  if (typeof document === "undefined" || typeof window === "undefined") {
    throw new Error(
      "installEnv requires a DOM: add `// @vitest-environment jsdom` to the test file",
    );
  }
  teardownInstalledRoot();
  (document.activeElement as HTMLElement | null)?.blur?.();
  document.body.replaceChildren();
  const root = document.createElement("div");
  document.body.appendChild(root);
  installedRoot = root;

  const doc = new TestDocument();
  root.addEventListener("click", (event) => doc.clicks.push(event.target as TestElement), {
    capture: true,
  });

  // Track window listeners by (type, listener, capture) — the DOM's own
  // de-duplication key — so re-adding the same listener does not double count.
  const listeners = new Map<string, Map<EventListenerOrEventListenerObject, Set<boolean>>>();
  const originalAdd = window.addEventListener.bind(window);
  const originalRemove = window.removeEventListener.bind(window);
  vi.spyOn(window, "addEventListener").mockImplementation(((
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ) => {
    if (listener !== null) {
      const byListener = listeners.get(type) ?? new Map();
      const captures = byListener.get(listener) ?? new Set<boolean>();
      captures.add(captureOf(options));
      byListener.set(listener, captures);
      listeners.set(type, byListener);
    }
    originalAdd(type, listener as EventListener, options);
  }) as never);
  vi.spyOn(window, "removeEventListener").mockImplementation(((
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | EventListenerOptions,
  ) => {
    if (listener !== null) {
      const byListener = listeners.get(type);
      const captures = byListener?.get(listener);
      captures?.delete(captureOf(options));
      if (captures !== undefined && captures.size === 0) byListener!.delete(listener);
    }
    originalRemove(type, listener as EventListener, options);
  }) as never);

  const win: WindowStub = {
    addEventListener: (type, listener, options) =>
      window.addEventListener(type, listener, options),
    removeEventListener: (type, listener, options) =>
      window.removeEventListener(type, listener, options),
    dispatchEvent: (event) => window.dispatchEvent(event),
    listenerCount(type) {
      let count = 0;
      for (const captures of listeners.get(type)?.values() ?? []) count += captures.size;
      return count;
    },
  };
  return { root, doc, win };
}

/**
 * Dispatch a cancelable `keydown` on `window`. With `target`, the event reports
 * that element as its `target` (as if it bubbled up from it) without firing any
 * element-level handlers.
 */
export function pressKey(
  win: WindowStub,
  key: string,
  options: { ctrl?: boolean; meta?: boolean; target?: EventTarget } = {},
): Event {
  const event = new KeyboardEvent("keydown", {
    key,
    ctrlKey: options.ctrl ?? false,
    metaKey: options.meta ?? false,
    cancelable: true,
  });
  if (options.target !== undefined) {
    Object.defineProperty(event, "target", { value: options.target });
  }
  win.dispatchEvent(event);
  return event;
}

/**
 * Set a (possibly React-controlled) input's value through the native setter and
 * fire a bubbling `input` event, which React's `onChange`/`onInput` listen to.
 */
export function typeInto(input: Element, value: string): void {
  const proto =
    input instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : input instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (setter === undefined) throw new Error("typeInto: element has no value setter");
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

// ---------------------------------------------------------------------------
// Invented inventory fixtures (no estate facts; deterministic).
// ---------------------------------------------------------------------------

export const FIXED_AT = "2030-01-01T00:00:00.000Z";

export function hostDecl(name: string, over: Partial<Host> = {}): Host {
  return { name, kind: "bare-metal", purpose: `${name} purpose`, ...over } as Host;
}

export function serviceDecl(
  host: string,
  name: string,
  over: Partial<Service> = {},
): Service {
  return {
    name,
    host,
    kind: "external",
    purpose: `${name} purpose`,
    ...over,
  } as Service;
}

export function observedHost(name: string, over: Partial<ObservedHost> = {}): ObservedHost {
  return { name, coverage: "collected", collectedAt: FIXED_AT, ...over } as ObservedHost;
}

export function observedService(
  host: string,
  name: string,
  over: Partial<ObservedService> = {},
): ObservedService {
  return { host, name, state: "running", ...over } as ObservedService;
}

export function hostState(
  state: HostState["state"],
  over: Partial<HostState> = {},
): HostState {
  const timestamped = state !== "unreachable" && state !== "never-collected";
  return {
    state,
    collectedAt: timestamped ? FIXED_AT : null,
    ageMs: timestamped ? 180_000 : null,
    pastStaleThreshold: false,
    ...over,
  };
}

export function config(hosts: Host[], services: Service[] = []): DeckConfig {
  return { schemaVersion: 1, estate: { name: "Inventory test estate" }, hosts, services } as DeckConfig;
}

export interface ResultOptions {
  hosts?: ObservedHost[];
  services?: ObservedService[];
  hostStates?: Record<string, HostState>;
  findings?: SnapshotProviderResult["findings"];
  readError?: SnapshotProviderResult["readError"];
}

export function snapshotResult(over: ResultOptions = {}): SnapshotProviderResult {
  return {
    snapshot: {
      schemaVersion: 1,
      generatedAt: FIXED_AT,
      hosts: over.hosts ?? [],
      services: over.services ?? [],
    } as SnapshotProviderResult["snapshot"],
    findings: over.findings ?? [],
    hostStates: over.hostStates ?? {},
    lastReadAt: FIXED_AT,
    readError: over.readError ?? null,
  };
}

export function availableState(
  result: SnapshotProviderResult,
  error: { message: string } | null = null,
): SnapshotClientState {
  const envelope: ProviderEnvelope<SnapshotProviderResult> = {
    id: "snapshot",
    kind: "snapshot",
    freshness: { state: "fresh", observedAt: FIXED_AT, ageMs: 1_000, ttlMs: 60_000 },
    data: result,
    error,
  };
  return { status: "available", envelope };
}

export const NOT_CONFIGURED: SnapshotClientState = { status: "not-configured" };

export function pendingState(): SnapshotClientState {
  return {
    status: "pending",
    envelope: {
      id: "snapshot",
      kind: "snapshot",
      freshness: { state: "pending", observedAt: null, ageMs: null, ttlMs: null },
      data: null,
      error: null,
    },
  };
}

export function failedEmptyState(message: string): SnapshotClientState {
  return {
    status: "failed-empty",
    envelope: {
      id: "snapshot",
      kind: "snapshot",
      freshness: { state: "unreachable", observedAt: null, ageMs: null, ttlMs: null },
      data: null,
      error: { message },
    },
  };
}

export function requestErrorState(message: string): SnapshotClientState {
  return { status: "request-error", message };
}

export interface DataOptions {
  config?: DeckConfig | null;
  configError?: string | null;
  snapshot?: SnapshotClientState;
  loading?: boolean;
}

/** Build one committed `InventoryData` generation using the real model builder. */
export function makeData(over: DataOptions = {}): InventoryData {
  const cfg = over.config === undefined ? config([hostDecl("h1")]) : over.config;
  const snapshot = over.snapshot ?? NOT_CONFIGURED;
  return {
    config: cfg,
    configError: over.configError ?? null,
    snapshot,
    model: cfg === null ? null : buildInventoryModel(cfg, snapshot),
    loading: over.loading ?? false,
  };
}

// ---------------------------------------------------------------------------
// Singleton inventory-store harness helpers.
//
// These deterministic seams prepare the shipped hosts-and-services test surface
// for the singleton inventory-store extraction. They are intentionally
// decoupled from any not-yet-implemented store module: no production symbol is
// imported here, so the helpers typecheck and run against the current tree while
// remaining directly usable by the future `inventory-store.test.ts`.
// ---------------------------------------------------------------------------

/** The two fixed aggregate GET endpoints the inventory poll uses. */
export const INVENTORY_TEST_ENDPOINTS = Object.freeze({
  config: "/api/config",
  snapshot: "/api/providers/snapshot",
} as const);

/**
 * Default `GET /api/providers` discovery response for stubbed fetch. Lists the
 * snapshot provider so `isProviderPollable("snapshot")` passes and the inventory
 * poll behaves exactly as before gating was introduced.
 */
const DEFAULT_PROVIDERS_INDEX = Object.freeze({
  providers: [{ id: "snapshot", kind: "snapshot" }],
});

/** A promise whose settlement the test drives explicitly (deferred/out-of-order). */
export interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason?: unknown): void;
}

/** Create a manually-settled promise for deferred aggregate responses. */
export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A `Response` carrying a decodable JSON body (default HTTP 200). */
export function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return Response.json(body, init);
}

/** A bodyless HTTP status `Response` (e.g. 404 not-configured, 500 upstream). */
export function httpStatusResponse(status: number): Response {
  return new Response(null, { status });
}

/** The snapshot 404 response classified as `not-configured`, never an error. */
export function notConfiguredResponse(): Response {
  return httpStatusResponse(404);
}

/** A 200 response whose body is not valid JSON, exercising the decode path. */
export function invalidJsonResponse(): Response {
  return new Response("not-json{", {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** A decodable config `Response` for the fixed config endpoint. */
export function configResponse(cfg: DeckConfig = config([hostDecl("h1")])): Response {
  return jsonResponse(cfg);
}

/**
 * A decodable snapshot `Response` for the fixed snapshot endpoint. `available`,
 * `pending`, and `failed-empty` serialize their exact envelope; `not-configured`
 * becomes a 404. A client `request-error` is not a server response — model it
 * with `httpStatusResponse`, `invalidJsonResponse`, or a rejected fetch instead.
 */
export function snapshotResponse(state: SnapshotClientState): Response {
  switch (state.status) {
    case "not-configured":
      return notConfiguredResponse();
    case "pending":
    case "failed-empty":
    case "available":
      return jsonResponse(state.envelope);
    case "request-error":
      throw new TypeError(
        "snapshotResponse cannot represent a client request-error; use httpStatusResponse, invalidJsonResponse, or a rejected fetch.",
      );
  }
}

/** Which fixed aggregate endpoint a stubbed `fetch` call targeted. */
export type InventoryEndpoint = "config" | "snapshot";

/** One recorded stubbed aggregate request. */
export interface RecordedFetch {
  readonly endpoint: InventoryEndpoint;
  readonly url: string;
  readonly init: RequestInit;
}

/** Handle over a stubbed aggregate `fetch`, with per-endpoint call accounting. */
export interface FetchStub {
  /** Every stubbed request in dispatch order. */
  readonly calls: readonly RecordedFetch[];
  /** Count of config-endpoint requests so far. */
  readonly configCalls: number;
  /** Count of snapshot-endpoint requests so far. */
  readonly snapshotCalls: number;
  /** Restore the pre-stub global `fetch`. */
  restore(): void;
}

/**
 * Stub the global `fetch` so aggregate config/snapshot polls resolve
 * deterministically. `handler` receives the endpoint, its zero-based per-endpoint
 * call index, and the request init (including the abort `signal`), and returns a
 * `Response` — synchronously, or via a `deferred()` promise for out-of-order and
 * abort-ignoring completions. Requests are recorded for one-poll/one-timer and
 * suppression assertions.
 */
export function stubFetch(
  handler: (
    endpoint: InventoryEndpoint,
    callIndex: number,
    init: RequestInit,
  ) => Response | Promise<Response>,
): FetchStub {
  const original = globalThis.fetch;
  const calls: RecordedFetch[] = [];
  const countFor = (endpoint: InventoryEndpoint): number =>
    calls.reduce((total, call) => total + (call.endpoint === endpoint ? 1 : 0), 0);

  const fetchStub = vi.fn(
    (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      // Provider discovery (`GET /api/providers`) is infrastructure, not an
      // aggregate poll: answer it with the registered set (snapshot present, so
      // gating passes through to the snapshot poll) and keep it out of the
      // recorded aggregate calls and per-endpoint counters.
      if (/\/api\/providers$/.test(url)) {
        return Promise.resolve(jsonResponse(DEFAULT_PROVIDERS_INDEX));
      }
      const endpoint: InventoryEndpoint = url.includes(
        INVENTORY_TEST_ENDPOINTS.snapshot,
      )
        ? "snapshot"
        : "config";
      const callIndex = countFor(endpoint);
      calls.push({ endpoint, url, init });
      return Promise.resolve(handler(endpoint, callIndex, init));
    },
  );
  vi.stubGlobal("fetch", fetchStub);

  return {
    calls,
    get configCalls() {
      return countFor("config");
    },
    get snapshotCalls() {
      return countFor("snapshot");
    },
    restore() {
      vi.stubGlobal("fetch", original);
    },
  };
}

/** Install Vitest fake timers and return a scoped restore for the poll interval. */
export function installInventoryTimers(): { restore(): void } {
  vi.useFakeTimers();
  return {
    restore() {
      vi.useRealTimers();
    },
  };
}

/**
 * Idempotent teardown for store-style tests: unmount any tree left in the
 * installed container, restore real timers, un-stub every
 * global (`fetch`, `document`, `window`, …), and reset spies. Safe to call from
 * `afterEach` even when nothing was installed.
 */
export function resetInventoryTestEnv(): void {
  teardownInstalledRoot();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetProvidersIndexCache();
}

/**
 * The current inventory bundle plus the browser-local acceptance metadata the
 * singleton store publishes. Structurally matches the future `InventoryGeneration`
 * without importing it, so this harness is usable before that module lands.
 */
export interface InventoryGenerationLike extends InventoryData {
  /** Monotonic accepted-generation id; zero means nothing accepted yet. */
  readonly refreshGeneration: number;
  /** Sanitized current refresh failure, or null after a complete response. */
  readonly transientError: string | null;
}

/** Overrides for one frozen inventory generation record. */
export interface GenerationOptions extends DataOptions {
  readonly refreshGeneration?: number;
  readonly transientError?: string | null;
}

/**
 * Build one frozen inventory generation using the real model builder. Mirrors the
 * store's publication contract: a frozen top-level record with an accepted
 * `refreshGeneration` and a sanitized `transientError`.
 */
export function makeGeneration(
  over: GenerationOptions = {},
): InventoryGenerationLike {
  const { refreshGeneration, transientError, ...dataOver } = over;
  const data = makeData(dataOver);
  return Object.freeze({
    ...data,
    snapshot: Object.freeze(data.snapshot),
    refreshGeneration: refreshGeneration ?? (data.model === null ? 0 : 1),
    transientError: transientError ?? null,
  });
}
