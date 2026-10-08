import type { Hono } from "hono";

import type { JsonObject, JsonValue } from "./json.js";
import type { ModuleManifest } from "./manifest.js";

/** Context passed to every provider poll; aborted when the poll times out. */
export interface ProviderFetchContext {
  signal: AbortSignal;
}

export interface ProviderHealth {
  ok: boolean;
  detail?: string;
}

/** A data provider the kernel registry polls and serves at `/api/providers/<id>`. */
export interface ProviderSpec<T = unknown> {
  readonly id: string;
  readonly kind: string;
  /** Cached, non-I/O health. */
  health(): Promise<ProviderHealth>;
  fetch(context?: ProviderFetchContext): Promise<T>;
  /** Optionally project a failed poll into retained data without recording success. */
  onFetchError?(error: unknown, retainedData: Readonly<T> | null): T | null;
}

export interface ProviderTiming {
  pollIntervalMs?: number;
  ttlMs?: number;
  unreachableAfterMs?: number;
  timeoutMs?: number;
  failureFreshness?: "immediate-unreachable" | "age-retained";
}

/** What a cadence hook sees when deciding the next run. */
export interface CadenceState {
  now: number;
  /** When the latest run finished; null before the first. */
  lastRunAt: number | null;
  /** Whether the latest run succeeded; null before the first. */
  lastOk: boolean | null;
  /** Failed runs since the last success. */
  consecutiveFailures: number;
}

/**
 * Adaptive cadence: the delay in ms until the next run, or null to pause until `wake()`.
 * It is re-evaluated after every run and on every `wake()`.
 */
export type Cadence = (state: CadenceState) => number | null;

export interface ScheduledTask {
  /** Short name used in logs; unique within the module. */
  name: string;
  run(): Promise<void>;
  cadence: Cadence;
}

export interface TaskHandle {
  /** Re-evaluate the cadence now (resume from a pause, or bring the next run forward). */
  wake(): void;
  /** Run immediately; joins a run already in flight. */
  runNow(): Promise<void>;
  /**
   * Cancel the task; it never runs again. Resolves once a run in flight has finished, or at
   * once when called from inside that run.
   */
  stop(): Promise<void>;
}

export interface ProviderRegistration extends ProviderTiming {
  /**
   * Adaptive cadence; without it the provider polls every `pollIntervalMs`. Either way the
   * first poll happens as soon as polling starts. A static provider cannot take a cadence.
   */
  cadence?: Cadence;
}

/** A structured log event. Module event names are open; prefix them with the module id. */
export interface ModuleLogEvent {
  event: string;
  [field: string]: unknown;
}

/** Logger scoped to one module; every line carries `module: <id>`. */
export interface ModuleLogger {
  debug(event: ModuleLogEvent, message?: string): void;
  info(event: ModuleLogEvent, message?: string): void;
  warn(event: ModuleLogEvent, message?: string): void;
  error(event: ModuleLogEvent, message?: string): void;
}

export interface ModuleHealth {
  state: "ok" | "degraded" | "error";
  detail?: string;
  data?: JsonValue;
}

/** One registered provider's poll statistics, as `ctx.providers.stats()` reads them. */
export interface ProviderStats {
  readonly id: string;
  readonly kind: string;
  /** Completed polls that fetched successfully. */
  readonly successTotal: number;
  /** Completed polls that failed or timed out. */
  readonly failureTotal: number;
  /** Duration of the latest completed poll in ms; null before the first. */
  readonly lastLatencyMs: number | null;
  /** Age of the cached data in ms (its envelope's `freshness.ageMs`); null for a static provider or before a success. */
  readonly ageMs: number | null;
}

/** One module's entry in `/api/health.modules`. */
export type ModuleHealthEntry = ModuleHealth | { state: "disabled"; detail: string };

/**
 * Services the kernel injects into a server module. Module code imports only types from
 * `@deck/module-sdk`; everything it touches at runtime comes through this context.
 */
export interface ServerModuleContext<C = unknown> {
  readonly id: string;
  /** The module's `modules.<id>` section; undefined when absent. */
  readonly config: C | undefined;
  readonly logger: ModuleLogger;
  readonly clock: { now(): number };
  readonly env: {
    /** Read a declared env var (`env` or `envFromConfig`); anything else reads undefined. */
    get(name: string): string | undefined;
  };
  /**
   * Init only. Later, inside the module's own request it throws; elsewhere it logs
   * `<id>.late-registration` and returns an inert handle.
   */
  readonly providers: {
    register<T>(provider: ProviderSpec<T>, options?: ProviderRegistration): TaskHandle;
    /**
     * Every registered provider's poll statistics, in id order: a read of the kernel's
     * cached state, with no upstream I/O. Read-only and callable at any time, by any module:
     * it carries no provider data or credentials, only poll bookkeeping beside the ids, kinds
     * and data ages `/api/providers` already serves.
     */
    stats(): readonly ProviderStats[];
  };
  /**
   * Init only (same late-call behaviour as `providers.register`). Tasks start once every
   * module is up.
   */
  readonly scheduler: {
    schedule(task: ScheduledTask): TaskHandle;
  };
  /**
   * The module's routes, mounted at `/api/m/<id>` and at every declared legacy alias.
   * Provisional: it exposes Hono's type directly until the module API's 1.0 freeze.
   */
  readonly http: Hono;
  /** Register a handler for a declared `contributes.routes.rootPaths` entry (init only). */
  rootRoute(path: string, handler: (request: Request) => Response | Promise<Response>): void;
  /**
   * The module's private data directory, `$DECK_DATA_DIR/modules/<id>` (or the manifest's
   * `dataDir.legacyPath`), created on first call. Throws when `DECK_DATA_DIR` is unset.
   */
  dataDir(): string;
  readonly health: {
    report(reporter: () => ModuleHealth): void;
  };
  /**
   * In-process services shared between modules. Both names must be declared in the manifest's
   * `services`; an undeclared name throws.
   */
  readonly services: ModuleServices;
  /**
   * The estate's `integrations[]` or `sources[]` declarations, as frozen copies in document
   * order. They name credential variables, never hold their values: `/api/config` serves the
   * same document.
   */
  instances(list: "integrations" | "sources"): readonly JsonObject[];
  /**
   * Teardown at shutdown. By default a hook runs once the module's scheduled work has
   * drained, in reverse registration order, within the host's per-hook bound. See
   * {@link StopHookOptions} for a hook that must start the moment shutdown begins.
   */
  onStop(hook: () => void | Promise<void>, options?: StopHookOptions): void;
}

export interface StopHookOptions {
  /**
   * Start the hook as soon as shutdown begins, beside every module's ordinary stop, rather
   * than after this module's scheduled work drains. For work that must settle within the
   * shutdown budget (cancelling runs that are still in flight, say).
   */
  early?: boolean;
  /**
   * The hook's own bound in ms, in place of the host's per-hook bound. The host's whole
   * module stage still bounds it; a hook still running at its bound is abandoned and logged
   * as `<id>.stop-hook-timeout`.
   */
  timeoutMs?: number;
}

export type ServerModuleInit<C = unknown> = (ctx: ServerModuleContext<C>) => void | Promise<void>;

/** Which config document a rule sees: one authored layer, or the merged document. */
export type ConfigLayer = "base" | "overlay" | "merged";

/** A problem a config rule reports in the module's own section. */
export interface ConfigRuleFinding {
  /** A code the manifest declares in `config.findings`; its severity comes from there. */
  code: string;
  /** JSON Pointer relative to the module's section (`""` is the section itself). */
  path: string;
  message: string;
  hint?: string;
}

/**
 * A config check the section schema cannot express. It runs for every validated document
 * that has the module's section, before any module code initialises, so it must be pure:
 * no I/O, no clock, no env. Rules are code, so they live on the server module, not in the
 * manifest.
 */
export type ConfigRule<C = unknown> = (
  section: C,
  context: { layer: ConfigLayer },
) => readonly ConfigRuleFinding[];

/**
 * A typed handle on a service name. The type is the service's interface, which the module that
 * defines the service exports; any module may build the handle as a plain `{ name }` object.
 */
export interface ServiceRef<T> {
  readonly name: string;
  /** Type-only: never set. */
  readonly __service?: T;
}

/** A {@link ServiceRef} for `name`. A convenience: `{ name }` is equally valid. */
export function serviceRef<T>(name: string): ServiceRef<T> {
  return Object.freeze({ name });
}

/**
 * Services one module offers and reads. They are scoped to one running module host: an offer
 * becomes visible once its module has started (its init returned), and every offer is
 * released when the host stops or its start fails. Offers of a module that does not start (a
 * kind handler failed, init threw) are never visible.
 */
export interface ModuleServices {
  /** Init only. Offer `impl` under a name the manifest lists in `services.provides`. */
  provide<T>(ref: ServiceRef<T>, impl: T): void;
  /**
   * Every started module's offer of a name the manifest lists in `services.uses`, in init order
   * (none when no running module provides it). Called during init, it sees every provider, since
   * they initialise first.
   */
  get<T>(ref: ServiceRef<T>): readonly T[];
  /**
   * The same offers as {@link get}, each with who made it, so a user can decide whose answer
   * counts (a built-in's over another module's, say).
   */
  offers<T>(ref: ServiceRef<T>): readonly ServiceOffer<T>[];
}

/** One module's offer of a service. */
export interface ServiceOffer<T> {
  /** The offering module's id. */
  readonly module: string;
  /** Whether it is one of deck's built-in modules. */
  readonly builtin: boolean;
  /** The provider kinds its manifest declares. */
  readonly providerKinds: readonly string[];
  readonly impl: T;
}

/** Reads environment variables a module is allowed to see; any other name reads undefined. */
export interface EnvReader {
  get(name: string): string | undefined;
}

/** What a provider-kind handler may use. */
export interface ProviderKindContext {
  /** Reads the module's declared `env` names only. */
  readonly env: EnvReader;
  /** The module's scoped logger: every line carries `module: <id>`. */
  readonly logger: ModuleLogger;
  /**
   * An env reader for one instance the handler consumes: the declared names plus the
   * `credentialEnv` that instance names (a well-formed name the kernel does not reserve and no
   * other module owns). Only the instance objects the kernel passed to `instances` are
   * recognised; any other object, such as one built by the handler, gets the declared-only
   * reader. Give it to the provider built from that instance, so a provider never sees
   * another instance's credential.
   */
  envFor(instance: JsonObject): EnvReader;
  /**
   * Offer a service built from the instances (a reader over the stores the providers use, say),
   * as `ServerModuleContext.services.provide` does. It becomes visible once the module starts.
   */
  readonly services: Pick<ModuleServices, "provide">;
  /**
   * The validated estate document, deep-frozen: the same document `/api/config` serves. It names
   * credential variables, never holds their values. For a provider that reads the estate as a
   * whole (validating observed hosts against declared ones, say).
   */
  readonly estate: Readonly<JsonObject>;
}

/**
 * Thrown by a kind handler for a deployment setting deck cannot start with (a malformed source
 * location, say): boot fails with its message on stderr and exit code 2, as for a bad estate
 * config. Keep the message free of secrets. A built-in-only privilege: any other module's
 * throw, this one included, disables that module and boot continues.
 */
export class BootFatalError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "BootFatalError";
  }
}

/** A provider a kind handler asks the kernel to register. */
export interface ProviderOffer<T = unknown> {
  provider: ProviderSpec<T>;
  timing?: ProviderTiming;
  /**
   * The provider id is fixed and public (clients address it literally), so it is reserved like
   * an estate id: another estate provider with the same id fails boot (`PROVIDER_DUPLICATE_ID`)
   * instead of disabling this module. A built-in-only privilege, honoured on `instances` offers
   * only: it is ignored on binding offers, and a non-built-in module's offer carrying it is
   * treated as module-chosen (on a clash the module is disabled and boot continues).
   */
  fixedId?: boolean;
}

/** One `hosts[].bindings.<kind>` or `services[].bindings.<kind>` entry. */
export interface ProviderBinding {
  /**
   * The provider id for this binding: its own `id` when it has one, else
   * `<kind>:<owner>`.
   */
  id: string;
  /** The entity it is bound to: `host:<name>` or `service:<host>:<name>`. */
  owner: string;
  /** The binding as written (frozen). */
  value: JsonObject;
  /** The env reader for this binding: the module's declared names only. */
  env: EnvReader;
}

/**
 * How a module turns estate declarations of one provider kind into providers. The kernel
 * calls it while registering providers, before any module init runs; it must not do I/O.
 */
export interface ProviderKindHandler {
  /**
   * One binding of this kind on a host or service. Required for a kind the manifest marks
   * `bindable`; return no offers when the binding only selects from another provider's data.
   */
  binding?(binding: ProviderBinding, context: ProviderKindContext): readonly ProviderOffer[];
  /**
   * Every `integrations[]` (or `sources[]`) instance of this kind, in document order, as frozen
   * copies the kernel issued (so `envFor` can recognise them). Each offered provider must be of
   * this kind, with an id no other provider has; otherwise the module is disabled.
   */
  instances?(instances: readonly JsonObject[], context: ProviderKindContext): readonly ProviderOffer[];
  /**
   * A config check over one `integrations[]` (or `sources[]`) instance of this kind that its
   * instance schema cannot express (a URL the runtime parser rejects, say). It runs on the
   * merged document of every validation, for each instance of the kind, before any module code
   * initialises, so it must be pure: no I/O, no clock, no env. Each finding's `path` is relative
   * to the instance, and its `code` one the kind's declaration lists in `findings`.
   */
  validate?(instance: JsonObject, context: { layer: ConfigLayer }): readonly ConfigRuleFinding[];
}

export interface ServerModule<C = unknown> {
  readonly manifest: ModuleManifest;
  readonly init: ServerModuleInit<C>;
  /** Validation rules over the module's config section. */
  readonly configRules?: readonly ConfigRule<C>[];
  /** Handlers for the provider kinds the manifest declares, by kind. */
  readonly kinds?: Readonly<Record<string, ProviderKindHandler>>;
}

/**
 * Declare a module's server half: its manifest plus an init run once, in dependency order.
 * A convenience only: a plain `{ manifest, init }` object is equally valid, so a module can
 * import nothing but types from this package.
 */
export function defineServerModule<C = unknown>(
  manifest: ModuleManifest,
  init: ServerModuleInit<C>,
  options: {
    configRules?: readonly ConfigRule<C>[];
    kinds?: Readonly<Record<string, ProviderKindHandler>>;
  } = {},
): ServerModule<C> {
  return Object.freeze({
    manifest,
    init,
    ...(options.configRules === undefined ? {} : { configRules: options.configRules }),
    ...(options.kinds === undefined ? {} : { kinds: options.kinds }),
  });
}
