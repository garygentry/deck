import { mkdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import {
  resolvePointer,
  type Cadence,
  type JsonObject,
  type ModuleHealth,
  type ModuleLogger,
  type ModuleManifest,
  type ProviderRegistration,
  type ProviderSpec,
  type ProviderStats,
  type ScheduledTask,
  type ServerModuleContext,
  type ServiceOffer,
  type ServiceRef,
  type TaskHandle,
} from "@deck/module-sdk";
import { AsyncLocalStorage } from "node:async_hooks";

import { Hono } from "hono";
import type { Logger } from "pino";

import type { ProviderConfig } from "../contract/index.js";
import { createAdaptiveTask } from "./scheduler.js";

/** Env var names a module may read: upper-case letters, digits and underscores. */
export const ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;

/**
 * The deployment settings the kernel itself reads (the server and the container entrypoint).
 * No module may declare one in `env`, and a config pointer cannot unlock one. A module's own
 * settings are the names its manifest `env` owns. Any other name, `DECK_*` included, is the
 * operator's to choose for a credential (the llm-usage ingest token's variable, say).
 */
export const KERNEL_ENV_NAMES: ReadonlySet<string> = new Set([
  "DECK_CONFIG_DIR",
  "DECK_DATA_DIR",
  "DECK_LOG_LEVEL",
  "DECK_PORT",
  "DECK_SNAPSHOT_OUT",
  "DECK_WEB_DIST",
]);

/** Set while a module's own HTTP handler runs, so late registrations there fail the request. */
const requestScope = new AsyncLocalStorage<true>();

/** Run `fn` as a module request (root-route handlers are mounted through this). */
export function inModuleRequest<T>(fn: () => T): T {
  return requestScope.run(true, fn);
}

const inertHandle = (): TaskHandle => ({ wake() {}, async runNow() {}, async stop() {} });

export type RootHandler = (request: Request) => Response | Promise<Response>;

/**
 * Registers a provider with the kernel registry (injectable for tests). `flags.static` marks
 * a provider of a kind declared static; it is passed only when set.
 */
export type RegisterProvider = <T>(
  provider: ProviderSpec<T>,
  options: ProviderConfig | undefined,
  cadence: Cadence | undefined,
  flags?: { static: true },
) => TaskHandle;

export interface ContextDeps {
  env: Readonly<Record<string, string | undefined>>;
  /** Env names other modules own: a config pointer cannot unlock them. */
  foreignEnv?: ReadonlySet<string>;
  logger: Logger;
  clock: { now(): number };
  registerProvider: RegisterProvider;
  /** Reads every registered provider's poll statistics (injectable for tests). */
  providerStats: () => readonly ProviderStats[];
  /** Provider kinds enabled modules declare `static`. */
  staticKinds?: ReadonlySet<string>;
  /** The host's services, for this module: offers wait until it has started. */
  services?: { offer(name: string, impl: unknown): void; offers(name: string): readonly ServiceOffer<unknown>[] };
  /** The estate's instance lists (`integrations[]`, `sources[]`); absent reads as empty. */
  instances?: (list: "integrations" | "sources") => readonly unknown[];
}

/** Frozen copies of an estate instance list's objects. */
export function frozenInstances(items: readonly unknown[] | undefined): readonly JsonObject[] {
  const objects = (items ?? []).filter((item): item is JsonObject => typeof item === "object" && item !== null && !Array.isArray(item));
  return Object.freeze(objects.map((item) => deepFreeze(structuredClone(item))));
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/** A registered `onStop` hook with its options. */
export interface StopHook {
  readonly run: () => void | Promise<void>;
  readonly early: boolean;
  /** The hook's own bound; undefined means the host's per-hook bound. */
  readonly timeoutMs?: number;
}

/** What the host keeps per started module: the context plus everything init registered. */
export interface ModuleRuntimeState {
  readonly ctx: ServerModuleContext<unknown>;
  readonly http: Hono;
  readonly rootRoutes: Map<string, RootHandler>;
  readonly stopHooks: StopHook[];
  readonly tasks: (TaskHandle & { start(): void })[];
  readonly providerHandles: TaskHandle[];
  reporter: (() => ModuleHealth) | null;
  /** End the init phase: registering providers or scheduling tasks afterwards throws. */
  seal(): void;
  /** Whether the module added any route of its own to `http` (beyond the kernel's scope middleware). */
  hasHttpRoutes(): boolean;
}

export class ModuleDataDirError extends Error {
  readonly code = "MODULE_DATA_DIR_INVALID";
  constructor(moduleId: string, reason: string) {
    super(`module "${moduleId}" called dataDir(): ${reason}`);
    this.name = "ModuleDataDirError";
  }
}

/**
 * The env var names a module may read: `env` and `sharedEnv`, plus well-formed names found in its config at
 * the `envFromConfig` pointers, except kernel settings ({@link KERNEL_ENV_NAMES}) and names
 * another module owns (`foreign`).
 */
export function allowedEnvNames(
  manifest: ModuleManifest,
  config: unknown,
  foreign: ReadonlySet<string> = new Set(),
): ReadonlySet<string> {
  const names = new Set([...(manifest.env ?? []), ...(manifest.sharedEnv ?? [])]);
  for (const pointer of manifest.envFromConfig ?? []) {
    const value = resolvePointer(config, pointer);
    if (typeof value !== "string" || !ENV_NAME_PATTERN.test(value)) continue;
    if ((KERNEL_ENV_NAMES.has(value) || foreign.has(value)) && !names.has(value)) continue;
    names.add(value);
  }
  return names;
}

/**
 * The `credentialEnv` an instance of one of the module's own kinds declares, when it is a
 * well-formed env name; otherwise null.
 */
export function declaredCredentialEnv(manifest: ModuleManifest, instance: unknown): string | null {
  if (instance === null || typeof instance !== "object") return null;
  const { kind, credentialEnv } = instance as { kind?: unknown; credentialEnv?: unknown };
  if (!(manifest.providerKinds ?? []).some((decl) => decl.kind === kind)) return null;
  return typeof credentialEnv === "string" && ENV_NAME_PATTERN.test(credentialEnv) ? credentialEnv : null;
}

/**
 * Why module `moduleId` may not read `name` as an instance's credential (completing "it is …"),
 * or null when it may. A kernel setting ({@link KERNEL_ENV_NAMES}) and a name another module
 * owns (`envOwners`: name to owning module) are refused: config can never reopen a reserved or
 * foreign name. Boot (a warn line) and config validation (MODULE_CREDENTIAL_ENV_REFUSED) both
 * report it.
 */
export function credentialEnvRefusal(
  name: string,
  moduleId: string,
  envOwners: ReadonlyMap<string, string> = new Map(),
): string | null {
  if (KERNEL_ENV_NAMES.has(name)) return "a deployment setting the kernel reads";
  const owner = envOwners.get(name);
  if (owner !== undefined && owner !== moduleId) return `module "${owner}"'s setting`;
  return null;
}


/** A logger scoped to one module: every line carries `module: <id>`. */
export function scopedLogger(logger: Logger, moduleId: string): ModuleLogger {
  const child = logger.child({ module: moduleId });
  return {
    debug: (event, message) => child.debug(event, message),
    info: (event, message) => child.info(event, message),
    warn: (event, message) => child.warn(event, message),
    error: (event, message) => child.error(event, message),
  };
}

/** Build the injected services for one module. Nothing here is shared between modules. */
export function createModuleContext(
  manifest: ModuleManifest,
  config: unknown,
  deps: ContextDeps,
): ModuleRuntimeState {
  const id = manifest.id;
  const logger = scopedLogger(deps.logger, id);
  const http = new Hono();
  // Mark the module's request handling first, so it covers every route the module adds.
  http.use("*", (_context, next) => inModuleRequest(() => next()));
  const kernelRouteCount = http.routes.length;
  const declaredRootPaths = new Set(manifest.contributes?.routes?.rootPaths ?? []);
  const envNames = allowedEnvNames(manifest, config, deps.foreignEnv);
  const provides = new Set(manifest.services?.provides ?? []);
  const uses = new Set(manifest.services?.uses ?? []);
  let dataDir: string | null = null;
  let sealed = false;
  /**
   * Whether an init-only service may run now. After init, a call inside a module request
   * throws (Hono answers 500); anywhere else (a timer, a detached promise) a throw would be
   * uncaught and take the process down, so it is logged and refused instead.
   */
  const duringInit = (service: string): boolean => {
    if (!sealed) return true;
    const message = `module "${id}": ${service} is only available during init`;
    if (requestScope.getStore() === true) throw new Error(message);
    logger.warn({ event: `${id}.late-registration`, service }, message);
    return false;
  };

  const parts: Omit<ModuleRuntimeState, "ctx"> = {
    http,
    rootRoutes: new Map(),
    stopHooks: [],
    tasks: [],
    providerHandles: [],
    reporter: null,
    hasHttpRoutes: () => http.routes.length > kernelRouteCount,
    seal: () => {
      sealed = true;
    },
  };

  const offersOf = <T>(ref: ServiceRef<T>): readonly ServiceOffer<T>[] => {
    if (!uses.has(ref.name)) throw new Error(`module "${id}" read service "${ref.name}" without declaring it in services.uses`);
    return (deps.services?.offers(ref.name) ?? []) as readonly ServiceOffer<T>[];
  };

  const ctx: ServerModuleContext<unknown> = {
    id,
    config,
    logger,
    clock: deps.clock,
    env: {
      get: (name) => (envNames.has(name) ? deps.env[name] : undefined),
    },
    providers: {
      register: (provider, options?: ProviderRegistration) => {
        if (!duringInit("ctx.providers.register")) return inertHandle();
        const { cadence, ...timing } = options ?? {};
        const handle = deps.staticKinds?.has(provider.kind)
          ? deps.registerProvider(provider, options === undefined ? undefined : timing, cadence, { static: true })
          : deps.registerProvider(provider, options === undefined ? undefined : timing, cadence);
        parts.providerHandles.push(handle);
        return handle;
      },
      stats: () => deps.providerStats(),
    },
    scheduler: {
      schedule: (task: ScheduledTask) => {
        if (!duringInit("ctx.scheduler.schedule")) return inertHandle();
        const handle = createAdaptiveTask({
          run: () => task.run(),
          cadence: task.cadence,
          now: () => deps.clock.now(),
          onError: (error, phase) =>
            logger.warn(
              { event: `${id}.task-error`, task: task.name, phase, error: error instanceof Error ? error.message : String(error) },
              "module task failed",
            ),
        });
        parts.tasks.push(handle);
        return handle;
      },
    },
    http,
    rootRoute: (path, handler) => {
      if (!duringInit("ctx.rootRoute")) return;
      if (!declaredRootPaths.has(path)) {
        throw new Error(`module "${id}" registered root path "${path}" without declaring it in contributes.routes.rootPaths`);
      }
      if (parts.rootRoutes.has(path)) throw new Error(`module "${id}" registered root path "${path}" twice`);
      parts.rootRoutes.set(path, handler);
    },
    dataDir: () => {
      if (dataDir !== null) return dataDir;
      const root = deps.env.DECK_DATA_DIR;
      if (root === undefined || root.trim() === "") {
        throw new ModuleDataDirError(id, "DECK_DATA_DIR is required for module data.");
      }
      if (!isAbsolute(root)) throw new ModuleDataDirError(id, `DECK_DATA_DIR must be absolute; got "${root}".`);
      const dir = join(root, ...(manifest.dataDir?.legacyPath === undefined ? ["modules", id] : [manifest.dataDir.legacyPath]));
      try {
        mkdirSync(dir, { recursive: true });
      } catch (cause) {
        throw new ModuleDataDirError(id, `cannot create ${dir}: ${(cause as Error).message}`);
      }
      dataDir = dir;
      return dir;
    },
    services: {
      provide: (ref, impl) => {
        if (!provides.has(ref.name)) throw new Error(`module "${id}" offered service "${ref.name}" without declaring it in services.provides`);
        if (!duringInit("ctx.services.provide")) return;
        deps.services?.offer(ref.name, impl);
      },
      get: <T>(ref: ServiceRef<T>) => Object.freeze(offersOf(ref).map((offer) => offer.impl)),
      offers: <T>(ref: ServiceRef<T>) => offersOf(ref),
    },
    instances: (list) => frozenInstances(deps.instances?.(list)),
    health: {
      report: (reporter) => {
        parts.reporter = reporter;
      },
    },
    onStop: (hook, options = {}) => {
      const { timeoutMs } = options;
      if (timeoutMs !== undefined && !(Number.isFinite(timeoutMs) && timeoutMs > 0)) {
        throw new Error(`module "${id}": onStop timeoutMs must be a positive number of ms`);
      }
      parts.stopHooks.push({ run: hook, early: options.early === true, ...(timeoutMs === undefined ? {} : { timeoutMs }) });
    },
  };
  const state: ModuleRuntimeState = Object.assign(parts, { ctx });
  return state;
}
