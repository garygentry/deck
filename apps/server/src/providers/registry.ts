import {
  POLL_DEFAULTS,
  type FailureFreshness,
  type FreshnessState,
  type Provider,
  type ProviderConfig,
  type ProviderDescriptor,
  type ProviderEnvelope,
  type ProviderHealthEntry,
  type ProviderProjection,
} from "../contract/index.js";
import type { Cadence, ProviderStats, TaskHandle } from "@deck/module-sdk";
import { evaluateSelect } from "@deck/schema/select";

import { logger, type ProviderPollEvent } from "../log/logger.js";
import { createAdaptiveTask, isWithinRun, withinRun, type AdaptiveTask } from "../modules/scheduler.js";

export interface ResolvedTiming {
  pollIntervalMs: number;
  ttlMs: number;
  unreachableAfterMs: number;
  timeoutMs: number;
  failureFreshness: FailureFreshness;
}

export interface DeriveInput {
  isStatic: boolean;
  hasSuccess: boolean;
  errored: boolean;
  failureFreshness: FailureFreshness;
  ageMs: number | null;
  ttlMs: number;
  unreachableAfterMs: number;
}

interface Slot<T = unknown> {
  readonly provider: Provider<T>;
  readonly timing: ResolvedTiming;
  readonly isStatic: boolean;
  envelope: ProviderEnvelope<T>;
  /** RFC 3339 timestamp of the latest successful fetch only. */
  lastSuccessAt: string | null;
  /** Current publishable payload, including an optional failure projection. */
  retainedData: T | null;
  /** Cached non-I/O health published by the latest completed poll. */
  health: ProviderHealthEntry;
  timer?: ReturnType<typeof setInterval>;
  /** Present when the provider polls on an adaptive cadence instead of a fixed interval. */
  adaptive?: AdaptiveTask;
  /** The poll in flight, shared by every caller until it settles. */
  polling: Promise<boolean> | null;
  /** Set by the handle's stop(): the provider never polls again. */
  stopped: boolean;
  /** Wall-clock duration of the latest completed poll; null before the first poll. */
  lastLatencyMs: number | null;
  /** Completed polls that fetched successfully. */
  successCount: number;
  /** Completed polls that failed (threw, rejected, or timed out). */
  failureCount: number;
  /** The projections last evaluated, and the data and projection set they were evaluated over. */
  projected?: { data: unknown; selects: ReadonlyMap<string, string> | undefined; result: ProviderEnvelope["projections"] };
}

/** One widget's `select` over a provider: the projection's name (the widget id) → expression. */
export type ProviderSelects = ReadonlyMap<string, string>;

/** Per-provider poll counters and last-poll latency, retained on the slot by tick(). */
export interface ProviderPollMetrics {
  readonly id: string;
  readonly kind: ProviderDescriptor["kind"];
  readonly successTotal: number;
  readonly failureTotal: number;
  /** Latest completed poll duration in ms; null before the first poll. */
  readonly lastLatencyMs: number | null;
}

const slots = new Map<string, Slot<unknown>>();
/** The selects to evaluate, by provider id; replaced whole by {@link setProjections}. */
let selectsByProvider: ReadonlyMap<string, ProviderSelects> = new Map();

/**
 * Replace the selects every provider's envelope carries as `projections` (by provider id, then
 * projection name → JMESPath expression). Each is evaluated over the provider's data when that
 * data changes and when the set changes, never per read; a provider registered later picks its
 * selects up. A select that fails on the data yields `{ error }` in its projection; the poll
 * and the provider's health are unaffected.
 */
export function setProjections(selects: ReadonlyMap<string, ProviderSelects>): void {
  selectsByProvider = selects;
  for (const slot of slots.values()) publish(slot, slot.envelope.error);
}

/** Derive the public freshness state from cached success, age, and failure policy. */
export function deriveState(input: DeriveInput): FreshnessState {
  if (input.isStatic) return "static";
  if (!input.hasSuccess) return "pending";
  if (input.errored && input.failureFreshness === "immediate-unreachable") return "unreachable";
  const age = input.ageMs ?? Number.POSITIVE_INFINITY;
  if (age > input.unreachableAfterMs) return "unreachable";
  if (age > input.ttlMs) return "stale";
  return "fresh";
}

/** Resolve provider timing defaults, including the TTL-derived unreachable threshold. */
export function resolveTiming(opts?: ProviderConfig): ResolvedTiming {
  const ttlMs = opts?.ttlMs ?? POLL_DEFAULTS.ttlMs;
  return {
    pollIntervalMs: opts?.pollIntervalMs ?? POLL_DEFAULTS.pollIntervalMs,
    ttlMs,
    unreachableAfterMs: opts?.unreachableAfterMs ?? 3 * ttlMs,
    timeoutMs: opts?.timeoutMs ?? POLL_DEFAULTS.timeoutMs,
    failureFreshness: opts?.failureFreshness ?? "immediate-unreachable",
  };
}

/**
 * Register one provider and initialize its cached envelope; duplicate ids throw.
 * With a `cadence`, the scheduler polls it adaptively (the hook picks each next delay, or
 * pauses until `wake()`) instead of every `pollIntervalMs`; either way the first poll runs as
 * soon as the scheduler starts. A static provider (`flags.static`, from a kind its module
 * declares static) is fetched once at registration, never polled, and cannot take a cadence.
 * The returned handle lets the owner wake, force (joining a poll in flight) or permanently
 * stop its polling.
 */
export function register<T>(
  provider: Provider<T>,
  opts?: ProviderConfig,
  cadence?: Cadence,
  flags?: { static?: boolean },
): TaskHandle {
  const isStatic = flags?.static === true;
  if (cadence !== undefined && isStatic) {
    throw new Error(`Provider ${provider.id} is static (kind "${provider.kind}") and cannot take a cadence`);
  }
  if (slots.has(provider.id)) {
    const error = new Error(`Provider id already registered: ${provider.id}`) as Error & {
      code: string;
    };
    error.code = "PROVIDER_DUPLICATE_ID";
    throw error;
  }

  const slot = {
    provider,
    timing: resolveTiming(opts),
    isStatic,
    lastSuccessAt: null,
    retainedData: null,
    health: { kind: provider.kind, ok: false, detail: "Awaiting first poll" },
    polling: null,
    stopped: false,
    lastLatencyMs: null,
    successCount: 0,
    failureCount: 0,
  } as Slot<T>;
  publish(slot, null);
  slots.set(provider.id, slot as Slot<unknown>);

  if (slot.isStatic) tick(slot).catch(() => {});
  if (cadence !== undefined) {
    slot.adaptive = createAdaptiveTask({
      cadence,
      // A failed poll is already published by tick(); throwing only feeds the cadence state.
      run: async () => {
        if (!(await tick(slot))) throw new Error("provider poll failed");
      },
    });
  }
  return {
    wake: () => slot.adaptive?.wake(),
    runNow: async () => {
      if (slot.adaptive !== undefined) await slot.adaptive.runNow();
      else await tick(slot);
    },
    stop: async () => {
      slot.stopped = true;
      if (slot.timer !== undefined) clearInterval(slot.timer);
      slot.timer = undefined;
      await slot.adaptive?.stop();
      // Stopped from inside its own poll (the provider stopping itself): never await itself.
      if (isWithinRun(slot)) return;
      await slot.polling;
    },
  };
}

/** Whether a provider with this id is registered. */
export function hasProvider(id: string): boolean {
  return slots.has(id);
}

/** Read one cached envelope without invoking provider, filesystem, or network I/O. */
export function read(id: string): ProviderEnvelope<unknown> | undefined {
  const slot = slots.get(id);
  if (!slot) return undefined;
  publish(slot, slot.envelope.error);
  return slot.envelope;
}

/** Start polling every registered dynamic provider and trigger its initial poll. */
export function startScheduler(): void {
  for (const slot of slots.values()) {
    if (slot.stopped) continue;
    if (slot.adaptive !== undefined) {
      // Like a fixed-interval provider, poll at once; the cadence takes over from there.
      slot.adaptive.start();
      slot.adaptive.runNow().catch(() => {});
      continue;
    }
    if (slot.isStatic || slot.timer !== undefined) continue;
    slot.timer = setInterval(() => void tick(slot).catch(() => {}), slot.timing.pollIntervalMs);
    tick(slot).catch(() => {});
  }
}

/** Stop every polling timer and clear all registered provider state. */
export function stopScheduler(): void {
  for (const slot of slots.values()) {
    if (slot.timer !== undefined) clearInterval(slot.timer);
    slot.stopped = true;
    slot.adaptive?.stop().catch(() => {});
  }
  slots.clear();
  selectsByProvider = new Map();
}

/** Return the number of providers currently held by the process-local registry. */
export function providerCount(): number {
  return slots.size;
}

/** Return cached provider envelopes in deterministic id order without provider I/O. */
export function listEnvelopes(): readonly ProviderEnvelope<unknown>[] {
  return [...slots.keys()].sort().map((id) => read(id)!);
}

/**
 * Return the registered providers' identities (id + kind) in deterministic id
 * order. Performs no provider, filesystem, or network I/O — it is the discovery
 * list the web reads so it polls only providers that actually registered.
 */
export function listProviders(): readonly ProviderDescriptor[] {
  return [...slots.keys()].sort().map((id) => ({ id, kind: slots.get(id)!.provider.kind }));
}

/**
 * Return a deeply frozen, id-sorted snapshot of cached provider health.
 * Performs no provider, filesystem, or network I/O.
 */
export function listHealth(): Readonly<Record<string, ProviderHealthEntry>> {
  const result = Object.create(null) as Record<string, ProviderHealthEntry>;
  for (const id of [...slots.keys()].sort()) {
    result[id] = Object.freeze({ ...slots.get(id)!.health });
  }
  return Object.freeze(result);
}

/**
 * Return per-provider poll counters and last-poll latency in deterministic id order.
 * Performs no provider, filesystem, or network I/O.
 */
export function listMetrics(): readonly ProviderPollMetrics[] {
  return [...slots.keys()].sort().map((id) => {
    const slot = slots.get(id)!;
    return Object.freeze({
      id,
      kind: slot.provider.kind,
      successTotal: slot.successCount,
      failureTotal: slot.failureCount,
      lastLatencyMs: slot.lastLatencyMs,
    });
  });
}

/**
 * Every provider's poll counters, last-poll latency and cached-data age, in id order, as
 * modules read them through `ctx.providers.stats()`. Performs no provider I/O; the age is
 * the one `read()` publishes.
 */
export function listStats(): readonly ProviderStats[] {
  return listMetrics().map((poll) => Object.freeze({ ...poll, ageMs: read(poll.id)!.freshness.ageMs }));
}

/**
 * Poll once, joining a poll already in flight; resolves true when the fetch succeeded.
 * A stopped provider never polls (resolves false).
 */
function tick<T>(slot: Slot<T>): Promise<boolean> {
  if (slot.polling !== null) return slot.polling;
  if (slot.stopped) return Promise.resolve(false);
  // Publish the shared poll before provider code runs, so a re-entrant call joins it.
  slot.polling = Promise.resolve().then(() => withinRun(slot, () => poll(slot))).finally(() => {
    slot.polling = null;
  });
  return slot.polling;
}

async function poll<T>(slot: Slot<T>): Promise<boolean> {
  const startedAt = Date.now();
  const from = slot.envelope.freshness.state;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), slot.timing.timeoutMs);
  let ok = false;

  try {
    const data = await withTimeout(
      slot.provider.fetch({ signal: controller.signal }),
      controller.signal,
      slot.timing.timeoutMs,
    );
    slot.lastSuccessAt = new Date().toISOString();
    slot.retainedData = data;
    publish(slot, null);
    ok = true;
    slot.health = await captureHealth(slot);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    projectFailure(slot, error);
    publish(slot, { message });
    slot.health = { kind: slot.provider.kind, ok: false, detail: message };
  } finally {
    clearTimeout(timeout);
    const latencyMs = Date.now() - startedAt;
    slot.lastLatencyMs = latencyMs;
    if (ok) slot.successCount += 1;
    else slot.failureCount += 1;
    try {
      // A failed poll logs at warn so it stays visible under DECK_LOG_LEVEL=warn;
      // a successful poll stays at info.
      const pollEvent = {
        event: "provider.poll",
        id: slot.provider.id,
        kind: slot.provider.kind,
        ok,
        latencyMs,
        from,
        to: slot.envelope.freshness.state,
      } satisfies ProviderPollEvent;
      if (ok) {
        logger.info(pollEvent, "provider poll");
      } else {
        logger.warn(pollEvent, "provider poll failed");
      }
    } catch {
      // Observability must never turn an isolated provider failure into a scheduler failure.
    }
  }
  return ok;
}

/** Read the now non-I/O provider health, isolating a rejecting or invalid snapshot. */
async function captureHealth<T>(slot: Slot<T>): Promise<ProviderHealthEntry> {
  try {
    const health = await slot.provider.health();
    if (health === null || typeof health !== "object" || typeof health.ok !== "boolean") {
      return { kind: slot.provider.kind, ok: false, detail: "Provider health unavailable" };
    }
    return { kind: slot.provider.kind, ok: health.ok, ...(health.detail === undefined ? {} : { detail: health.detail }) };
  } catch {
    return { kind: slot.provider.kind, ok: false, detail: "Provider health unavailable" };
  }
}

/**
 * Project a failed poll into retained data via the optional hook without recording success.
 * A throwing hook is isolated and leaves the pre-hook retained data unchanged.
 */
function projectFailure<T>(slot: Slot<T>, error: unknown): void {
  if (slot.provider.onFetchError === undefined) return;
  try {
    const projected = slot.provider.onFetchError(error, slot.retainedData);
    slot.retainedData = projected === null ? null : deepFreeze(projected);
  } catch {
    // Hook exceptions are never published; retain the pre-hook payload unchanged.
  }
}

function publish<T>(slot: Slot<T>, error: { message: string } | null): void {
  const observedAt = slot.isStatic ? null : slot.lastSuccessAt;
  const ageMs = observedAt === null ? null : Math.max(0, Date.now() - Date.parse(observedAt));
  const state = deriveState({
    isStatic: slot.isStatic,
    hasSuccess: slot.lastSuccessAt !== null,
    errored: error !== null,
    failureFreshness: slot.timing.failureFreshness,
    ageMs,
    ttlMs: slot.timing.ttlMs,
    unreachableAfterMs: slot.timing.unreachableAfterMs,
  });
  slot.envelope = deepFreeze({
    id: slot.provider.id,
    kind: slot.provider.kind,
    freshness: {
      state,
      observedAt,
      ageMs: slot.isStatic ? null : ageMs,
      ttlMs: slot.isStatic ? null : slot.timing.ttlMs,
    },
    data: slot.retainedData,
    error,
    ...projectionsOf(slot),
  });
}

/** The slot's projections, re-evaluated only when its data or the select set changed. */
function projectionsOf<T>(slot: Slot<T>): Pick<ProviderEnvelope, "projections"> {
  const selects = selectsByProvider.get(slot.provider.id);
  if (slot.projected === undefined || slot.projected.data !== slot.retainedData || slot.projected.selects !== selects) {
    let result: Record<string, ProviderProjection> | undefined;
    if (selects !== undefined && selects.size > 0) {
      result = {};
      // No data yet (or none retained): nothing to project.
      if (slot.retainedData !== null) {
        for (const [name, expression] of [...selects].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
          result[name] = evaluateSelect(expression, slot.retainedData);
        }
      }
    }
    slot.projected = { data: slot.retainedData, selects, result };
  }
  return slot.projected.result === undefined ? {} : { projections: slot.projected.result };
}

function withTimeout<T>(promise: Promise<T>, signal: AbortSignal, timeoutMs: number): Promise<T> {
  if (signal.aborted) return Promise.reject(timeoutError(timeoutMs));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(timeoutError(timeoutMs));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

function timeoutError(timeoutMs: number): Error {
  const error = new Error(`Provider poll timed out after ${timeoutMs}ms`);
  error.name = "TimeoutError";
  return error;
}

/**
 * Freeze `value` and everything reachable from it. Iterative, so provider data of any depth
 * cannot overflow the stack on the publish path (an uncaught overflow there ends the process).
 */
function deepFreeze<T>(value: T): T {
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === null || typeof current !== "object" || Object.isFrozen(current)) continue;
    Object.freeze(current);
    for (const child of Object.values(current as Record<string, unknown>)) pending.push(child);
  }
  return value;
}
