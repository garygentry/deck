import {
  DECK_API_VERSION,
  isDeckApiRange,
  jsonSnapshot,
  MODULE_ID_PATTERN,
  SERVICE_NAME_PATTERN,
  satisfiesDeckApi,
  type DisabledRouteDecl,
  type JsonObject,
  type JsonValue,
  type ModuleHealthEntry,
  type ModuleManifest,
  type ProviderKindContext,
  type ProviderKindHandler,
  type ProviderStats,
  type ServerModule,
  type ServiceOffer,
  type TaskHandle,
} from "@deck/module-sdk";
import { MODULE_HOST_FINDING_CATALOG, type Finding, type ModuleHostFindingCode } from "@deck/schema";
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Logger } from "pino";

import { parseBool } from "../config/env.js";
import { KERNEL_FEATURES } from "../ui/kernel-features.js";
import { RESERVED_MODULE_IDS, uiContributionProblem } from "../ui/validate.js";
import { logger as kernelLogger, type ModuleDisabledEvent, type ModuleInitEvent, type ModuleStopEvent } from "../log/logger.js";
import { listStats, register as registryRegister } from "../providers/registry.js";
import { settlesWithin } from "../server/settle.js";
import { ServiceRegistry } from "./services.js";
import {
  createModuleContext,
  credentialEnvRefusal,
  declaredCredentialEnv,
  ENV_NAME_PATTERN,
  inModuleRequest,
  KERNEL_ENV_NAMES,
  scopedLogger,
  type ModuleRuntimeState,
  type RegisterProvider,
  type StopHook,
} from "./context.js";
import {
  aliasProblem,
  isCatchAllMiddleware,
  MODULE_ROUTE_PREFIX,
  patternMatchesPath,
  patternReachesPrefix,
  prefixesOverlap,
  rootPathProblem,
  segments,
} from "./routes.js";

/**
 * Codes of module-host findings: the `MODULE_HOST_FINDING_CATALOG` entries other than the
 * boot-failing conflict, which is thrown instead.
 */
export type ModuleFindingCode = Exclude<ModuleHostFindingCode, "MODULE_MANIFEST_CONFLICT">;

/** A module-host finding: the schema `Finding` shape, with a catalogued host code. */
export interface ModuleFinding extends Finding {
  code: ModuleFindingCode;
}

/**
 * Modules that cannot coexist (a duplicate id, a shared legacy health key, overlapping
 * routes) or a module route the kernel already serves. Unlike a defect local to one module,
 * which only disables that module, this fails boot.
 */
export class ModuleManifestError extends Error {
  readonly code = "MODULE_MANIFEST_CONFLICT";
  constructor(readonly moduleId: string, reason: string) {
    super(`module "${moduleId}": ${reason}`);
    this.name = "ModuleManifestError";
  }
}

/** A module's init threw; boot reports it and exits 2. */
export class ModuleInitError extends Error {
  readonly code = "MODULE_INIT_FAILED";
  constructor(readonly moduleId: string, override readonly cause: unknown) {
    super(`module "${moduleId}" failed to initialise: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "ModuleInitError";
  }
}

export interface ModulePlanEntry {
  readonly id: string;
  readonly enabled: boolean;
  /** Why the module is not running; absent when enabled. */
  readonly reason?: string;
}

export interface ModuleHostOptions {
  modules: readonly ServerModule<any>[];
  /** The module's config section (`modules.<id>`), or undefined when absent. */
  sectionOf(id: string): unknown;
  env: Readonly<Record<string, string | undefined>>;
  logger: Logger;
  clock?: { now(): number };
  registerProvider?: RegisterProvider;
  /** What `ctx.providers.stats()` reads (default: the kernel registry). */
  providerStats?: () => readonly ProviderStats[];
  /**
   * The kernel's route table (method + Hono pattern). A module whose prefix or root path one
   * of these could match is disabled at plan time, before its code runs.
   */
  kernelRoutes?: readonly KernelRoute[];
  /** Kernel-reserved root paths (served conditionally) no module may claim. */
  reservedRootPaths?: readonly string[];
  /**
   * Modules whose manifest is unusable for a reason found outside the host (their config
   * contribution does not compose), by id. They are disabled with MODULE_MANIFEST_INVALID.
   */
  manifestProblems?: ReadonlyMap<string, string>;
  /** Deck's built-in modules: they claim env names before any other module. */
  builtins?: ReadonlySet<ServerModule<any>>;
  /** The estate's `integrations[]` / `sources[]` lists, read through `ctx.instances` (default: empty). */
  instancesOf?: (list: "integrations" | "sources") => readonly unknown[];
  /** Upper bound on waiting for a module's in-flight runs at shutdown (default 5s). */
  drainTimeoutMs?: number;
  /** Upper bound on each `onStop` hook at shutdown (default 2s); a hook still running is abandoned. */
  hookTimeoutMs?: number;
  /**
   * The budget of the whole stop (the caller's module stage). No hook's bound outlasts what
   * is left of it, so a hook is abandoned, and logged, before the stage itself gives up.
   */
  stageTimeoutMs?: number;
}

export interface KernelRoute {
  method: string;
  path: string;
}

/** Default bound on draining a module's in-flight runs before its stop hooks run. */
export const DEFAULT_DRAIN_TIMEOUT_MS = 5_000;

/** What a stop keeps of its stage budget for abandoning late hooks and logging them. */
const STAGE_MARGIN_MS = 50;

/** Default bound on each module stop hook at shutdown. */
export const DEFAULT_HOOK_TIMEOUT_MS = 2_000;

export interface ModuleHealthSnapshot {
  /** Every known module by id, in id order. */
  modules: Record<string, ModuleHealthEntry>;
  /** Legacy top-level `/api/health` keys mirrored from module health data. */
  legacy: Record<string, JsonValue>;
}

export interface MountOptions {
  /** Kernel-reserved root paths (served conditionally) that no module may claim. */
  reservedRootPaths?: readonly string[];
}

export interface ModuleHost {
  /** Modules in init order (enabled first, dependency-ordered), then disabled ones by id. */
  readonly plan: readonly ModulePlanEntry[];
  readonly findings: readonly ModuleFinding[];
  /** The snapshot of every usable manifest (enabled or not), by id; unusable ones are absent. */
  readonly manifests: ReadonlyMap<string, ModuleManifest>;
  /** Ids of the modules that ship with deck (the `builtins` option). */
  readonly builtinIds: ReadonlySet<string>;
  /** Run every enabled module's init in dependency order; throws ModuleInitError. */
  start(): Promise<void>;
  /**
   * Mount module routes: `/api/m/<id>`, legacy aliases and declared root paths. Throws
   * ModuleManifestError when a module path collides with a route the kernel already serves.
   */
  mount(app: Hono, options?: MountOptions): void;
  /**
   * Every root path a usable manifest declares, enabled or not, so the SPA fallback never
   * rewrites a module's path to index.html.
   */
  rootPaths(): readonly string[];
  health(): ModuleHealthSnapshot;
  /**
   * The provider-kind handlers of enabled modules, by kind, for the kernel to register the
   * providers estate declarations ask for. Call before `start()`: a provider registered
   * through `adopt` stops with its module, and `fail` disables the module before it starts.
   */
  kindHandlers(): ReadonlyMap<string, KindRuntime>;
  /** Stop every started module in reverse init order (tasks drained first); never throws. */
  stop(): Promise<void>;
}

/** A provider-kind handler's context before registration supplies the estate. */
export type KindContextBase = Omit<ProviderKindContext, "estate">;

/** One enabled module's handler for one provider kind, ready for the kernel loop. */
export interface KindRuntime {
  readonly kind: string;
  readonly moduleId: string;
  /** Never polled: the manifest declares the kind `static`. */
  readonly static: boolean;
  /** A built-in module's kind: only these may reserve a `fixedId` (a built-in-only privilege). */
  readonly builtin: boolean;
  /** Which top-level list holds this kind's instances. */
  readonly instanceList: "integrations" | "sources";
  readonly handler: ProviderKindHandler;
  /** The handler context, but for `estate`, which registration adds from the config it reads. */
  readonly context: KindContextBase;
  /**
   * Issue the instances to pass to the `instances` handler: deep-frozen copies, each bound to
   * its own credential, so `context.envFor` recognises only these objects.
   */
  issueInstances(instances: readonly JsonObject[]): readonly JsonObject[];
  /** Hand a registered provider's handle to the module, so it is stopped with it. */
  adopt(handle: TaskHandle): void;
  /**
   * Report that a handler of this module failed: none of the module's offers are registered,
   * and the module is disabled with MODULE_KIND_HANDLER_FAILED (outside a host, this throws).
   */
  fail(reason: string): void;
}

/** Top-level `/api/health` keys a module's `legacyKey` may not shadow. */
export const KERNEL_HEALTH_KEYS: ReadonlySet<string> = new Set([
  "status",
  "uptimeMs",
  "providerCount",
  "providers",
  "modules",
]);

const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const findingPath = (id: string) => `/modules/${id.replace(/~/g, "~0").replace(/\//g, "~1")}`;
const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

/** Why a manifest is unusable on its own terms, or null. Cross-module checks come later. */
function manifestProblem(manifest: ModuleManifest, reservedPagePaths: readonly string[]): string | null {
  if (typeof manifest.id !== "string" || !MODULE_ID_PATTERN.test(manifest.id)) return "id must be lowercase kebab-case";
  if (RESERVED_MODULE_IDS.has(manifest.id)) return `id "${manifest.id}" is reserved for the kernel`;
  if (typeof manifest.version !== "string") return "version must be a string";
  if (typeof manifest.deckApi !== "string") return "deckApi must be a string";
  if (manifest.dependsOn !== undefined && !isStringArray(manifest.dependsOn)) return "dependsOn must be a list of module ids";
  if (manifest.env !== undefined && !Array.isArray(manifest.env)) return "env must be a list of names";
  for (const name of manifest.env ?? []) {
    if (typeof name !== "string" || !ENV_NAME_PATTERN.test(name)) return `env name "${String(name)}" must match ${ENV_NAME_PATTERN.source}`;
    if (KERNEL_ENV_NAMES.has(name)) return `env name "${name}" is a deployment setting the kernel reads`;
  }
  if (manifest.sharedEnv !== undefined && !Array.isArray(manifest.sharedEnv)) return "sharedEnv must be a list of names";
  for (const name of manifest.sharedEnv ?? []) {
    if (typeof name !== "string" || !ENV_NAME_PATTERN.test(name)) return `sharedEnv name "${String(name)}" must match ${ENV_NAME_PATTERN.source}`;
    if (KERNEL_ENV_NAMES.has(name)) return `sharedEnv name "${name}" is a deployment setting the kernel reads`;
    if ((manifest.env ?? []).includes(name)) return `env name "${name}" is also listed in sharedEnv`;
  }
  const references: unknown = manifest.config?.references;
  // Each entry's shape is checked where the section is composed.
  if (references !== undefined && !Array.isArray(references)) return "config.references must be a list";
  const legacyPath: unknown = manifest.dataDir?.legacyPath;
  if (manifest.dataDir !== undefined && (typeof legacyPath !== "string" || !/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(legacyPath) || legacyPath === "modules")) {
    return `dataDir.legacyPath "${String(legacyPath)}" must be one directory name other than "modules"`;
  }
  for (const pointer of manifest.envFromConfig ?? []) {
    if (typeof pointer !== "string" || (pointer !== "" && !pointer.startsWith("/"))) return `envFromConfig entry "${String(pointer)}" must be a JSON Pointer`;
  }
  const services: unknown = manifest.services;
  if (services !== undefined) {
    if (typeof services !== "object" || services === null || Array.isArray(services)) return "services must be an object";
    const { provides = [], uses = [] } = services as { provides?: unknown; uses?: unknown };
    for (const [key, names] of [["provides", provides], ["uses", uses]] as const) {
      if (!isStringArray(names)) return `services.${key} must be a list of names`;
      const bad = names.find((name) => !SERVICE_NAME_PATTERN.test(name));
      if (bad !== undefined) return `services.${key} name "${bad}" must match ${SERVICE_NAME_PATTERN.source}`;
    }
    const both = (provides as string[]).find((name) => (uses as string[]).includes(name));
    if (both !== undefined) return `service "${both}" is both provided and used`;
  }
  const flag = manifest.enabledBy?.env;
  if (flag !== undefined && (typeof flag !== "string" || !ENV_NAME_PATTERN.test(flag))) return `enabledBy.env "${String(flag)}" must match ${ENV_NAME_PATTERN.source}`;
  const legacyKey = manifest.health?.legacyKey;
  if (legacyKey !== undefined && (typeof legacyKey !== "string" || legacyKey === "" || KERNEL_HEALTH_KEYS.has(legacyKey))) {
    return `health.legacyKey "${String(legacyKey)}" must be a non-empty key that does not shadow a kernel field`;
  }
  const aliases = manifest.contributes?.routes?.legacyAliases ?? [];
  if (!isStringArray(aliases)) return "legacyAliases must be a list of paths";
  for (const [index, alias] of aliases.entries()) {
    const problem = aliasProblem(alias);
    if (problem !== null) return `legacy alias "${alias}" ${problem}`;
    const other = aliases.find((candidate, j) => j !== index && prefixesOverlap(candidate, alias));
    if (other !== undefined) return `legacy aliases "${other}" and "${alias}" overlap`;
  }
  const rootPaths = manifest.contributes?.routes?.rootPaths ?? [];
  if (!isStringArray(rootPaths)) return "rootPaths must be a list of paths";
  for (const path of rootPaths) {
    const problem = rootPathProblem(path);
    if (problem !== null) return `root path "${path}" ${problem}`;
  }
  const whenDisabled: unknown = manifest.contributes?.routes?.whenDisabled ?? [];
  if (!Array.isArray(whenDisabled)) return "whenDisabled must be a list of routes";
  const seenRoutes = new Set<string>();
  for (const route of whenDisabled as unknown[]) {
    const problem = disabledRouteProblem(route);
    if (problem !== null) return `whenDisabled route ${problem}`;
    const { method, path } = route as DisabledRouteDecl;
    if (seenRoutes.has(`${method} ${path}`)) return `whenDisabled route ${method} "${path}" is declared twice`;
    seenRoutes.add(`${method} ${path}`);
  }
  return uiContributionProblem(manifest, { reservedRootPaths: reservedPagePaths });
}

/** A snapshotted manifest's declared root paths, read defensively (it is validated later). */
function snapshotRootPaths(manifest: ModuleManifest): string[] {
  const paths: unknown = manifest.contributes?.routes?.rootPaths;
  return Array.isArray(paths) ? paths.filter((path): path is string => typeof path === "string") : [];
}

/** Provider kind names: the shape of a `bindings` key. */
const KIND_PATTERN = /^[a-z][a-z0-9-]*$/;

/**
 * Why a module's provider kinds and their handlers do not fit together, or null: a kind
 * declared twice or badly named, a `bindable` kind without a binding handler, a handler for
 * a kind the manifest does not declare, or instances handled for a `static` kind.
 */
function kindsProblem(manifest: ModuleManifest, kinds: Readonly<Record<string, ProviderKindHandler>>): string | null {
  const declared = new Map<string, NonNullable<ModuleManifest["providerKinds"]>[number]>();
  const providerKinds = manifest.providerKinds ?? [];
  if (!Array.isArray(providerKinds)) return "providerKinds must be a list";
  for (const decl of providerKinds) {
    if (decl === null || typeof decl !== "object" || typeof decl.kind !== "string" || !KIND_PATTERN.test(decl.kind)) {
      return `provider kind "${String(decl?.kind)}" must match ${KIND_PATTERN.source}`;
    }
    if (declared.has(decl.kind)) return `provider kind "${decl.kind}" is declared twice`;
    declared.set(decl.kind, decl);
  }
  const handlers = kinds;
  for (const [kind, handler] of Object.entries(handlers)) {
    if (!declared.has(kind)) return `kinds has a handler for "${kind}", which the manifest does not declare`;
    if (handler === null || typeof handler !== "object") return `the handler for "${kind}" must be an object`;
    for (const name of ["binding", "instances"] as const) {
      if (handler[name] !== undefined && typeof handler[name] !== "function") return `the ${name} handler for "${kind}" must be a function`;
    }
    if (declared.get(kind)!.static === true && handler.instances !== undefined) {
      return `provider kind "${kind}" is static, so it cannot handle instances`;
    }
  }
  for (const [kind, decl] of declared) {
    if (decl.bindable === true && handlers[kind]?.binding === undefined) {
      return `provider kind "${kind}" is bindable, but the module has no binding handler for it`;
    }
  }
  return null;
}

/**
 * Read a module's kind handlers exactly once: a copy of the map, and of each handler's two
 * functions, so what is validated is what runs. A throwing getter, or a value of the wrong
 * shape, is the module's own defect.
 */
function snapshotKinds(module: ServerModule<any>): { kinds: Readonly<Record<string, ProviderKindHandler>> } | { problem: string } {
  try {
    const raw: unknown = module.kinds;
    if (raw === undefined) return { kinds: {} };
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { problem: "kinds must map provider kinds to handlers" };
    const kinds: Record<string, ProviderKindHandler> = {};
    for (const [kind, handler] of Object.entries(raw as Record<string, unknown>)) {
      if (handler === null || typeof handler !== "object") return { problem: `the handler for "${kind}" must be an object` };
      const { binding, instances } = handler as ProviderKindHandler;
      kinds[kind] = Object.freeze({ ...(binding === undefined ? {} : { binding }), ...(instances === undefined ? {} : { instances }) });
    }
    return { kinds: Object.freeze(kinds) };
  } catch (cause) {
    return { problem: `kinds could not be read: ${(cause as Error).message}` };
  }
}

/**
 * Why a module's provider kinds and handlers are unusable on their own (reading nothing
 * twice), or null. Config composition checks this before composing the module, so a
 * module-local kind defect disables the module instead of failing boot.
 */
export function moduleKindsProblem(module: ServerModule<any>): string | null {
  let manifest: ModuleManifest;
  try {
    manifest = jsonSnapshot(module.manifest);
  } catch {
    return null; // The host reports an unserialisable manifest itself.
  }
  const snapshot = snapshotKinds(module);
  return "problem" in snapshot ? snapshot.problem : kindsProblem(manifest, snapshot.kinds);
}

/** Why a module's routes collide with the kernel's, or null (decidable from manifest data). */
function kernelCollision(
  manifest: ModuleManifest,
  kernelRoutes: readonly KernelRoute[],
  reservedRootPaths: ReadonlySet<string>,
): string | null {
  const routes = kernelRoutes.filter((route) => !isCatchAllMiddleware(route.path));
  for (const prefix of [`${MODULE_ROUTE_PREFIX}/${manifest.id}`, ...(manifest.contributes?.routes?.legacyAliases ?? [])]) {
    const clash = routes.find((route) => patternReachesPrefix(route.path, prefix));
    if (clash) return `route prefix "${prefix}" collides with kernel route ${clash.method} ${clash.path}`;
  }
  for (const path of manifest.contributes?.routes?.rootPaths ?? []) {
    if (reservedRootPaths.has(path)) return `root path "${path}" is reserved by the kernel`;
    const clash = routes.find((route) => patternMatchesPath(route.path, path));
    if (clash) return `root path "${path}" collides with kernel route ${clash.method} ${clash.path}`;
  }
  return null;
}

/** Statuses whose response has no body, which a `whenDisabled` answer always sends. */
const NULL_BODY_STATUSES: ReadonlySet<number> = new Set([204, 205, 304]);
const DISABLED_ROUTE_METHODS: ReadonlySet<string> = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const DISABLED_ROUTE_PATH = /^(?:\/(?::[A-Za-z][A-Za-z0-9_]*|[A-Za-z0-9._~-]+))*$/;

/** Why one `whenDisabled` entry is unusable, or null. */
function disabledRouteProblem(route: unknown): string | null {
  if (route === null || typeof route !== "object" || Array.isArray(route)) return "must be an object";
  const { method, path, status, body } = route as Record<string, unknown>;
  if (typeof method !== "string" || !DISABLED_ROUTE_METHODS.has(method)) return `method "${String(method)}" must be one of ${[...DISABLED_ROUTE_METHODS].join(", ")}`;
  if (typeof path !== "string" || !DISABLED_ROUTE_PATH.test(path) || segments(path).some((s) => s === "." || s === "..")) {
    return `path "${String(path)}" must be "" or "/"-separated literal or :param segments`;
  }
  if (typeof status !== "number" || !Number.isInteger(status) || status < 200 || status > 599) return `${method} "${path}" status must be an integer from 200 to 599`;
  if (NULL_BODY_STATUSES.has(status)) return `${method} "${path}" status ${status} cannot carry a body`;
  if (body === undefined) return `${method} "${path}" must have a body`;
  return null;
}

/** Every prefix a module is mounted at: `/api/m/<id>`, then its legacy aliases. */
function modulePrefixes(manifest: ModuleManifest): string[] {
  return [`${MODULE_ROUTE_PREFIX}/${manifest.id}`, ...(manifest.contributes?.routes?.legacyAliases ?? [])];
}

/** The fixed answers of a module that is not running, as a sub-app to mount at its prefixes. */
function disabledRoutes(routes: readonly DisabledRouteDecl[]): Hono {
  const stub = new Hono();
  for (const { method, path, status, body } of routes) {
    stub.on(method, path === "" ? "/" : path, (context) => context.json(body as Record<string, never>, status as ContentfulStatusCode));
  }
  return stub;
}

/** Collisions between usable manifests: each one fails boot. */
function assertCompatible(manifests: readonly ModuleManifest[]): void {
  const legacyKeys = new Map<string, string>();
  const prefixes: { prefix: string; id: string }[] = [];
  const rootPaths = new Map<string, string>();
  const dataDirs = new Map<string, string>();
  const kindOwners = new Map<string, string>();
  for (const manifest of manifests) {
    const { id } = manifest;
    const legacyPath = manifest.dataDir?.legacyPath;
    if (legacyPath !== undefined) {
      const owner = dataDirs.get(legacyPath);
      if (owner !== undefined) throw new ModuleManifestError(id, `dataDir.legacyPath "${legacyPath}" is already declared by "${owner}"`);
      dataDirs.set(legacyPath, id);
    }
    for (const { kind } of manifest.providerKinds ?? []) {
      const owner = kindOwners.get(kind);
      if (owner !== undefined) throw new ModuleManifestError(id, `provider kind "${kind}" is already declared by "${owner}"`);
      kindOwners.set(kind, id);
    }
    const legacyKey = manifest.health?.legacyKey;
    if (legacyKey !== undefined) {
      const owner = legacyKeys.get(legacyKey);
      if (owner !== undefined) throw new ModuleManifestError(id, `health.legacyKey "${legacyKey}" is already declared by "${owner}"`);
      legacyKeys.set(legacyKey, id);
    }
    for (const alias of manifest.contributes?.routes?.legacyAliases ?? []) {
      const clash = prefixes.find((entry) => prefixesOverlap(entry.prefix, alias));
      if (clash !== undefined) throw new ModuleManifestError(id, `legacy alias "${alias}" overlaps "${clash.prefix}" of "${clash.id}"`);
      prefixes.push({ prefix: alias, id });
    }
    for (const path of manifest.contributes?.routes?.rootPaths ?? []) {
      const owner = rootPaths.get(path);
      if (owner !== undefined) throw new ModuleManifestError(id, `root path "${path}" is already declared by "${owner}"`);
      rootPaths.set(path, id);
    }
  }
}

/**
 * Dependency order by Kahn's algorithm, taking the smallest id among ready modules so the
 * order is stable. A module that uses a service also follows every module providing it (an
 * ordering edge only: no provider is required). Modules left over sit in, or downstream of, a
 * dependency cycle.
 */
function topoOrder(manifests: readonly ModuleManifest[]): { order: string[]; stuck: string[] } {
  const known = new Set(manifests.map((m) => m.id));
  const pending = new Map<string, Set<string>>();
  for (const manifest of manifests) {
    const uses = new Set(manifest.services?.uses ?? []);
    const providers = manifests
      .filter((other) => other.id !== manifest.id && (other.services?.provides ?? []).some((name) => uses.has(name)))
      .map((other) => other.id);
    pending.set(manifest.id, new Set([...(manifest.dependsOn ?? []).filter((dep) => known.has(dep)), ...providers]));
  }
  const order: string[] = [];
  for (;;) {
    const ready = [...pending].filter(([, deps]) => deps.size === 0).map(([id]) => id).sort(compareText);
    if (ready.length === 0) break;
    const next = ready[0]!;
    order.push(next);
    pending.delete(next);
    for (const deps of pending.values()) deps.delete(next);
  }
  return { order, stuck: [...pending.keys()].sort(compareText) };
}

/**
 * A service edge (a user waiting for a provider) that closes a cycle through a built-in module
 * and has a non-built-in end, as that end's id, the service and the built-in; or null. The
 * modules' waits are their `dependsOn` and service edges.
 */
function builtinServiceCycle(
  manifests: readonly ModuleManifest[],
  builtinIds: ReadonlySet<string>,
): { id: string; service: string; builtin: string } | null {
  const known = new Set(manifests.map((m) => m.id));
  const waits = new Map<string, Set<string>>();
  const serviceEdges: Array<{ user: string; provider: string; service: string }> = [];
  for (const manifest of manifests) {
    waits.set(manifest.id, new Set((manifest.dependsOn ?? []).filter((dep) => known.has(dep))));
  }
  for (const user of manifests) {
    for (const service of user.services?.uses ?? []) {
      for (const provider of manifests) {
        if (provider.id === user.id || !(provider.services?.provides ?? []).includes(service)) continue;
        waits.get(user.id)!.add(provider.id);
        serviceEdges.push({ user: user.id, provider: provider.id, service });
      }
    }
  }
  /** Every module `from` waits on, directly or not (itself only through a cycle). */
  const reach = (from: string): Set<string> => {
    const seen = new Set<string>();
    const stack = [...waits.get(from)!];
    while (stack.length > 0) {
      const next = stack.pop()!;
      if (seen.has(next)) continue;
      seen.add(next);
      stack.push(...waits.get(next)!);
    }
    return seen;
  };
  const sorted = [...serviceEdges].sort((a, b) => compareText(a.user, b.user) || compareText(a.provider, b.provider) || compareText(a.service, b.service));
  for (const { user, provider, service } of sorted) {
    const external = !builtinIds.has(provider) ? provider : !builtinIds.has(user) ? user : null;
    if (external === null) continue;
    // The edge is on a cycle when the provider waits, transitively, on the user.
    const fromProvider = reach(provider);
    if (!fromProvider.has(user)) continue;
    // The cycle's modules: those the provider reaches that also reach the provider.
    const cycle = [user, provider, ...[...fromProvider].filter((id) => reach(id).has(provider))];
    const builtin = cycle.filter((id) => builtinIds.has(id)).sort(compareText)[0];
    if (builtin !== undefined) return { id: external, service, builtin };
  }
  return null;
}

/** A module whose manifest passed planning: the snapshot, its init and kind handlers. */
export interface UsableModule {
  manifest: ModuleManifest;
  init: ServerModule<any>["init"];
  kinds: Readonly<Record<string, ProviderKindHandler>>;
}

/** What planning decides: the plan, the host findings, and the usable manifests by id. */
export interface ModulePlanning {
  readonly plan: readonly ModulePlanEntry[];
  readonly findings: readonly ModuleFinding[];
  readonly usable: ReadonlyMap<string, UsableModule>;
  /** Why each module that will not run is off, by id. */
  readonly disabled: ReadonlyMap<string, string>;
  /** Every module id seen, including malformed ones. */
  readonly seenIds: ReadonlySet<string>;
  /** The module that owns each env name a usable manifest declares. */
  readonly envOwners: ReadonlyMap<string, string>;
  /** Ids of the modules that ship with deck (the `builtins` option). */
  readonly builtinIds: ReadonlySet<string>;
}

export type PlanOptions = Pick<
  ModuleHostOptions,
  "modules" | "sectionOf" | "env" | "manifestProblems" | "kernelRoutes" | "reservedRootPaths" | "builtins"
>;

/**
 * Plan modules from their manifests alone, running no module code: snapshot and validate
 * each manifest, check `deckApi`, evaluate `enabledBy`, order by `dependsOn`, and disable
 * (with a finding) any module whose manifest, API range, dependencies or dependency graph is
 * unusable. Throws {@link ModuleManifestError} for modules that cannot coexist. Config
 * loading plans the same way (without kernel routes) so it validates only enabled modules.
 */
export function planModules(options: PlanOptions): ModulePlanning {
  const reservedRootPaths = new Set(options.reservedRootPaths ?? []);
  const findings: ModuleFinding[] = [];
  const disabled = new Map<string, string>();
  const refuse = (id: string, code: ModuleFindingCode, message: string) => {
    findings.push({ code, severity: MODULE_HOST_FINDING_CATALOG[code].severity, path: findingPath(id), message });
    disabled.set(id, message);
  };

  // Snapshot every manifest once: planning, mounting and health read only these copies.
  const snapshots: { module: ServerModule<any>; id: string; manifest: ModuleManifest; builtin: boolean }[] = [];
  const seenIds = new Set<string>();
  for (const module of options.modules) {
    // Read the id through its descriptor: a getter must never run (it fails validation below).
    const rawId: unknown = Object.getOwnPropertyDescriptor(module.manifest ?? {}, "id")?.value;
    const id = typeof rawId === "string" ? rawId : String(rawId);
    // Only a well-formed id can claim a slot; malformed ones are each that module's own defect.
    if (typeof rawId === "string" && MODULE_ID_PATTERN.test(rawId)) {
      if (seenIds.has(id)) throw new ModuleManifestError(id, "duplicate module id");
    }
    seenIds.add(id);
    try {
      snapshots.push({ module, id, manifest: jsonSnapshot(module.manifest), builtin: options.builtins?.has(module) === true });
    } catch (cause) {
      refuse(id, "MODULE_MANIFEST_INVALID", `Module "${id}" has an invalid manifest: ${(cause as Error).message}.`);
    }
  }

  // No page may sit on a root path the kernel or a built-in module serves, running or not.
  // Read from the built-ins' snapshots only, never their live manifests.
  const reservedPagePaths = [
    ...reservedRootPaths,
    ...snapshots.filter((entry) => entry.builtin).flatMap((entry) => snapshotRootPaths(entry.manifest)),
  ];

  const usable = new Map<string, UsableModule>();
  const builtinIds = new Set<string>();
  for (const { module, id, manifest, builtin } of snapshots) {
    const kinds = snapshotKinds(module);
    const problem = manifestProblem(manifest, reservedPagePaths)
      // Only a built-in has data that predates modules.
      ?? (manifest.dataDir !== undefined && !builtin ? "dataDir.legacyPath is reserved for built-in modules" : null)
      ?? ("problem" in kinds ? kinds.problem : kindsProblem(manifest, kinds.kinds))
      ?? options.manifestProblems?.get(id)
      ?? kernelCollision(manifest, options.kernelRoutes ?? [], reservedRootPaths);
    if (problem !== null) {
      refuse(id, "MODULE_MANIFEST_INVALID", `Module "${id}" has an invalid manifest: ${problem}.`);
      continue;
    }
    usable.set(id, { manifest, init: module.init, kinds: "kinds" in kinds ? kinds.kinds : {} });
    if (builtin) builtinIds.add(id);
  }

  // A built-in's root paths and pages are its own, as the kernel's routes and pages are:
  // another module whose root path is one of them, or one a built-in or kernel page pattern
  // matches, is refused (enabled or not) and boot continues, so it neither serves the path
  // nor reserves it from the SPA. Two other modules sharing a root path fail boot below.
  const builtinRootPaths = new Map<string, string>();
  const protectedPages: { pattern: string; page: string; owner: string }[] = [];
  for (const id of builtinIds) {
    const { manifest } = usable.get(id)!;
    for (const path of manifest.contributes?.routes?.rootPaths ?? []) builtinRootPaths.set(path, id);
    for (const page of manifest.contributes?.pages ?? []) protectedPages.push({ pattern: page.path, page: page.id, owner: `built-in module "${id}"` });
  }
  for (const { manifest } of KERNEL_FEATURES) {
    for (const page of manifest.contributes?.pages ?? []) protectedPages.push({ pattern: page.path, page: page.id, owner: "the kernel" });
  }
  for (const [id, { manifest }] of [...usable]) {
    if (builtinIds.has(id)) continue;
    let problem: string | null = null;
    for (const path of manifest.contributes?.routes?.rootPaths ?? []) {
      const servedBy = builtinRootPaths.get(path);
      const page = protectedPages.find((candidate) => patternMatchesPath(candidate.pattern, path));
      if (servedBy !== undefined) problem = `root path "${path}" is served by built-in module "${servedBy}"`;
      else if (page !== undefined) problem = `root path "${path}" would shadow page "${page.page}" of ${page.owner}`;
      if (problem !== null) break;
    }
    if (problem === null) continue;
    usable.delete(id);
    refuse(id, "MODULE_MANIFEST_INVALID", `Module "${id}" has an invalid manifest: ${problem}.`);
  }

  const manifests = [...usable.values()].map((entry) => entry.manifest);
  assertCompatible(manifests);

  const notEnabledReason = (manifest: ModuleManifest): string | null => {
    const { id, enabledBy } = manifest;
    if (enabledBy?.config === true && options.sectionOf(id) === undefined) return `not enabled: no modules.${id} section`;
    if (enabledBy?.env !== undefined && !parseBool(options.env[enabledBy.env], false)) {
      return `not enabled: ${enabledBy.env} is not true`;
    }
    return null;
  };

  // Which modules could run: refuse those whose API range, dependencies or dependency graph
  // is unusable. `excluded` modules (env-name losers, below) count as missing dependencies.
  const resolve = (excluded: ReadonlyMap<string, string>) => {
    const findings: ModuleFinding[] = [];
    const disabled = new Map<string, string>();
    const refuse = (id: string, code: ModuleFindingCode, message: string) => {
      findings.push({ code, severity: MODULE_HOST_FINDING_CATALOG[code].severity, path: findingPath(id), message });
      disabled.set(id, message);
    };
    const candidates = manifests.filter((manifest) => !excluded.has(manifest.id));
    const { order, stuck } = topoOrder(candidates);
    for (const id of order) {
      const { manifest } = usable.get(id)!;
      const reason = notEnabledReason(manifest);
      if (reason !== null) {
        disabled.set(id, reason);
        // A section for a module that is not running is ignored; say so rather than silently.
        if (manifest.enabledBy?.env !== undefined && options.sectionOf(id) !== undefined) {
          findings.push({
            code: "MODULE_SECTION_DISABLED",
            severity: MODULE_HOST_FINDING_CATALOG.MODULE_SECTION_DISABLED.severity,
            path: findingPath(id),
            message: `modules.${id} is set, but module "${id}" is not enabled (${manifest.enabledBy.env} is not true); the section is ignored.`,
          });
        }
        continue;
      }
      if (!isDeckApiRange(manifest.deckApi) || !satisfiesDeckApi(manifest.deckApi)) {
        refuse(id, "MODULE_API_INCOMPATIBLE", `Module "${id}" requires deckApi ${manifest.deckApi}; this deck provides ${DECK_API_VERSION}.`);
        continue;
      }
      const missing = (manifest.dependsOn ?? []).filter((dep) => !usable.has(dep) || excluded.has(dep) || disabled.has(dep));
      if (missing.length > 0) {
        refuse(id, "MODULE_DEPENDENCY_MISSING", `Module "${id}" depends on ${missing.map((dep) => `"${dep}"`).join(", ")}, which ${missing.length === 1 ? "is" : "are"} not available.`);
      }
    }
    for (const id of stuck) {
      // A module that is not enabled anyway is not reported for its place in a cycle.
      const reason = notEnabledReason(usable.get(id)!.manifest);
      if (reason !== null) disabled.set(id, reason);
      else refuse(id, "MODULE_DEPENDENCY_CYCLE", `Module "${id}" is in, or depends on, a dependency cycle.`);
    }
    return { findings, disabled, order, refused: new Set(findings.filter((f) => f.code !== "MODULE_SECTION_DISABLED").map((f) => f.path)) };
  };

  // Env names are owned, by modules that could run (switched off by their flag included):
  // built-ins claim first, then the rest by id, and a later claimant is refused, so one
  // module's settings (a credential file, a data root) never reach another. `sharedEnv`
  // names are never owned, but cannot be a name some module owns. A refused claimant
  // frees its names and takes its dependants with it, so claims repeat until they settle.
  // Each round that does not settle adds at least one module to `envLosers`, which only
  // grows and never re-admits one, so there are at most as many rounds as modules.
  // A name a built-in shares is the built-ins' setting: no other module may own it.
  const builtinShared = new Set([...builtinIds].flatMap((id) => usable.get(id)!.manifest.sharedEnv ?? []));
  const envLosers = new Map<string, string>();
  for (const [id, { manifest }] of usable) {
    if (builtinIds.has(id)) continue;
    const claimed = (manifest.env ?? []).find((name) => builtinShared.has(name));
    if (claimed !== undefined) envLosers.set(id, `env name "${claimed}" is a setting built-in modules share`);
  }
  // A service edge never puts a built-in in a cycle: the other module on such an edge is
  // refused (and its edges dropped), one at a time, until no such cycle is left.
  for (;;) {
    const live = manifests.filter((manifest) => !envLosers.has(manifest.id));
    const loser = builtinServiceCycle(live, builtinIds);
    if (loser === null) break;
    envLosers.set(loser.id, `service "${loser.service}" would put built-in module "${loser.builtin}" in a dependency cycle`);
  }
  let resolved = resolve(envLosers);
  let envOwners = new Map<string, string>();
  for (let round = 0; ; round += 1) {
    if (round > usable.size) throw new Error("module env claims did not settle (a host bug)");
    envOwners = new Map();
    const claimants = [...usable.keys()]
      .filter((id) => !envLosers.has(id) && !resolved.refused.has(findingPath(id)))
      .sort((a, b) => Number(builtinIds.has(b)) - Number(builtinIds.has(a)) || compareText(a, b));
    const losers = new Map<string, string>();
    for (const id of claimants) {
      const names = usable.get(id)!.manifest.env ?? [];
      const taken = names.find((name) => envOwners.has(name));
      if (taken !== undefined) losers.set(id, `env name "${taken}" is owned by module "${envOwners.get(taken)}"`);
      else for (const name of names) envOwners.set(name, id);
    }
    for (const id of claimants) {
      if (losers.has(id)) continue;
      const shared = (usable.get(id)!.manifest.sharedEnv ?? []).find((name) => envOwners.has(name) && envOwners.get(name) !== id);
      if (shared !== undefined) losers.set(id, `shared env name "${shared}" is owned by module "${envOwners.get(shared)}"`);
    }
    if (losers.size === 0) break;
    for (const [id, reason] of losers) envLosers.set(id, reason);
    resolved = resolve(envLosers);
  }
  for (const [id, reason] of [...envLosers].sort(([a], [b]) => compareText(a, b))) {
    usable.delete(id);
    refuse(id, "MODULE_MANIFEST_INVALID", `Module "${id}" has an invalid manifest: ${reason}.`);
  }
  findings.push(...resolved.findings);
  for (const [id, reason] of resolved.disabled) disabled.set(id, reason);
  const { order } = resolved;

  const plan: ModulePlanEntry[] = [
    ...order.filter((id) => !disabled.has(id)).map((id) => ({ id, enabled: true })),
    ...[...disabled].sort(([a], [b]) => compareText(a, b)).map(([id, reason]) => ({ id, enabled: false, reason })),
  ];
  return { plan, findings, usable, disabled, seenIds, envOwners, builtinIds };
}

/**
 * The provider-kind handlers of the given (enabled) modules, by kind. Each module's handlers
 * read env through readers of their own: `env` holds its declared names, and `envFor(instance)`
 * adds that one instance's `credentialEnv`. `adopt` receives every provider registered for a
 * module's kinds; `fail` is told when one of its handlers fails (by default it throws).
 */
export function kindRuntimes(
  modules: readonly UsableModule[],
  env: Readonly<Record<string, string | undefined>>,
  adopt: (moduleId: string, handle: TaskHandle) => void = () => {},
  fail: (moduleId: string, reason: string) => void = (moduleId, reason) => {
    throw new Error(`module "${moduleId}" ${reason}`);
  },
  envOwners: ReadonlyMap<string, string> = new Map(),
  logger: Logger = kernelLogger,
  builtinIds: ReadonlySet<string> = new Set(),
  offer: (moduleId: string, name: string, impl: unknown) => void = () => {},
): ReadonlyMap<string, KindRuntime> {
  const runtimes = new Map<string, KindRuntime>();
  for (const { manifest, kinds } of modules) {
    // The names this module may read (planning has already refused kernel and foreign-owned
    // ones). Names another module owns are never reopened by an instance credential.
    const declared = new Set([...(manifest.env ?? []), ...(manifest.sharedEnv ?? [])]);
    const moduleLogger = scopedLogger(logger, manifest.id);
    const reader = (names: ReadonlySet<string>) =>
      Object.freeze({ get: (name: string) => (names.has(name) ? env[name] : undefined) });
    const declaredReader = reader(declared);
    // Instances the kernel issued to this module's handlers, each with the one credential it
    // may unlock. Any other object (one a handler made up, say) unlocks nothing.
    const issued = new WeakMap<object, string | null>();
    const issueInstances = (instances: readonly JsonObject[]) =>
      instances.map((instance) => {
        const copy = deepFreeze(structuredClone(instance));
        const name = declaredCredentialEnv(manifest, copy);
        const refusal = name === null ? null : credentialEnvRefusal(name, manifest.id, envOwners);
        if (refusal !== null) {
          // Names only, never values. Config validation reports the same refusal.
          moduleLogger.warn(
            { event: "provider.credential-env-refused", kind: copy.kind, instance: copy.id, env: name, reason: refusal },
            `module may not read credentialEnv ${name}: it is ${refusal}`,
          );
        }
        issued.set(copy, refusal === null ? name : null);
        return copy;
      });
    const provides = new Set(manifest.services?.provides ?? []);
    const context: KindContextBase = Object.freeze({
      services: Object.freeze({
        provide: (ref: { name: string }, impl: unknown) => {
          if (!provides.has(ref.name)) throw new Error(`offered service "${ref.name}" without declaring it in services.provides`);
          offer(manifest.id, ref.name, impl);
        },
      }),
      env: declaredReader,
      logger: moduleLogger,
      envFor: (instance: unknown) => {
        const credential = typeof instance === "object" && instance !== null ? issued.get(instance) : undefined;
        return credential === undefined || credential === null ? declaredReader : reader(new Set([...declared, credential]));
      },
    });
    for (const decl of manifest.providerKinds ?? []) {
      const handler = kinds[decl.kind];
      if (handler === undefined) continue;
      runtimes.set(decl.kind, {
        kind: decl.kind,
        moduleId: manifest.id,
        static: decl.static === true,
        builtin: builtinIds.has(manifest.id),
        instanceList: decl.instanceList ?? "integrations",
        handler,
        context,
        issueInstances,
        adopt: (handle) => adopt(manifest.id, handle),
        fail: (reason) => fail(manifest.id, reason),
      });
    }
  }
  return runtimes;
}

/**
 * Plan and run modules. Planning reads manifests only: it snapshots and validates each one,
 * checks `deckApi`, evaluates `enabledBy`, orders by `dependsOn`, and disables (with a
 * finding) any module whose manifest, API range, dependencies or dependency graph is
 * unusable. Modules that cannot coexist fail boot.
 */
export function createModuleHost(options: ModuleHostOptions): ModuleHost {
  const { logger } = options;
  const clock = options.clock ?? { now: () => Date.now() };
  const registerProvider: RegisterProvider = options.registerProvider ?? registryRegister;
  const drainTimeoutMs = options.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
  const hookTimeoutMs = options.hookTimeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS;
  const reservedRootPaths = new Set(options.reservedRootPaths ?? []);

  const planning = planModules(options);
  const { usable, seenIds, envOwners, builtinIds } = planning;
  const disabled = new Map(planning.disabled);
  // Mutable copies: a module whose kind handler fails is disabled after planning, before start.
  const plan: ModulePlanEntry[] = [...planning.plan];
  const findings: ModuleFinding[] = [...planning.findings];
  const manifests = [...usable.values()].map((entry) => entry.manifest);
  // Read from the live plan: a module a kind handler failed is no longer enabled.
  const enabledIds = () => plan.filter((entry) => entry.enabled).map((entry) => entry.id);
  // Kinds the enabled modules declare `static`: their providers are never polled.
  const staticKinds = () => new Set(
    enabledIds().flatMap((id) => (usable.get(id)!.manifest.providerKinds ?? []).filter((decl) => decl.static === true).map((decl) => decl.kind)),
  );
  // Providers the kernel registered for a module's kinds before its init, by module id.
  const adopted = new Map<string, TaskHandle[]>();
  // Services the modules offer one another; released when this host stops.
  const services = new ServiceRegistry();
  const serviceOffers = (name: string): readonly ServiceOffer<unknown>[] =>
    Object.freeze(services.entries(name).map(({ moduleId, impl }) => Object.freeze({
      module: moduleId,
      builtin: builtinIds.has(moduleId),
      providerKinds: Object.freeze((usable.get(moduleId)!.manifest.providerKinds ?? []).map((decl) => decl.kind)),
      impl,
    })));
  const instancesOf = (list: "integrations" | "sources") =>
    list === "integrations" || list === "sources" ? options.instancesOf?.(list) ?? [] : [];

  for (const entry of plan) {
    if (entry.enabled) continue;
    const code = findings.find((f) => f.path === findingPath(entry.id))?.code;
    const event: ModuleDisabledEvent = { event: "module.disabled", module: entry.id, reason: entry.reason!, ...(code ? { code } : {}) };
    if (code) logger.warn(event, "module disabled");
    else logger.info(event, "module not enabled");
  }

  const started: { id: string; state: ModuleRuntimeState }[] = [];

  /** Run one stop hook within its bound; a hook that fails or outlives it is logged, never thrown. */
  async function runHook(id: string, state: ModuleRuntimeState, hook: StopHook, deadline: number): Promise<void> {
    const bound = Math.max(0, Math.min(hook.timeoutMs ?? hookTimeoutMs, deadline - Date.now()));
    const run = Promise.resolve().then(hook.run).catch((error: unknown) => {
      // Module-scoped (open) event name; the kernel union stays closed.
      state.ctx.logger.error({ event: `${id}.stop-error`, error: error instanceof Error ? error.message : String(error) }, "module stop hook failed");
    });
    if (!(await settlesWithin(run, bound))) {
      state.ctx.logger.warn({ event: `${id}.stop-hook-timeout`, hookTimeoutMs: bound }, "module stop hook still running at shutdown; abandoning it");
    }
  }

  /** Start a module's early stop hooks, side by side; resolves once each has settled or timed out. */
  function startEarlyHooks(id: string, state: ModuleRuntimeState, deadline: number): Promise<unknown> {
    return Promise.all(state.stopHooks.filter((hook) => hook.early).map((hook) => runHook(id, state, hook, deadline)));
  }

  async function stopOne(id: string, state: ModuleRuntimeState, early: Promise<unknown>, deadline: number): Promise<void> {
    // Drain scheduled work first, so no run is mid-flight when teardown hooks close resources;
    // bounded, so a run that never settles cannot hang shutdown (or a failed boot).
    const drain = Promise.all([
      ...state.tasks.map((task) => task.stop()),
      ...state.providerHandles.map((handle) => handle.stop()),
    ]).then(() => true, () => true);
    if (!(await settlesWithin(drain, drainTimeoutMs))) {
      // Module-scoped (open) event name; the kernel union stays closed.
      state.ctx.logger.warn({ event: `${id}.stop-timeout`, drainTimeoutMs }, "module runs still in flight at shutdown; stopping anyway");
    }
    // Each hook is bounded, so one that never settles cannot hold up the rest of shutdown.
    for (const hook of state.stopHooks.filter((candidate) => !candidate.early).reverse()) {
      await runHook(id, state, hook, deadline);
    }
    await early;
    logger.info({ event: "module.stop", module: id } satisfies ModuleStopEvent, "module stopped");
  }

  /**
   * Stop every started module in reverse init order. Early hooks all start first, at once, so
   * they run beside the ordered stops rather than waiting for their module's turn.
   */
  async function stopAll(): Promise<void> {
    const stopping = started.splice(0).reverse();
    services.clear();
    // Leave a little of the stage for the abandon and its log line.
    const deadline = options.stageTimeoutMs === undefined ? Number.POSITIVE_INFINITY : Date.now() + options.stageTimeoutMs - STAGE_MARGIN_MS;
    const early = stopping.map(({ id, state }) => startEarlyHooks(id, state, deadline));
    for (const [index, { id, state }] of stopping.entries()) {
      await stopOne(id, state, early[index]!, deadline);
    }
  }

  const declaredRootPaths = manifests.flatMap((m) => m.contributes?.routes?.rootPaths ?? []).sort(compareText);

  return {
    plan,
    findings,
    manifests: new Map([...usable].map(([id, entry]) => [id, entry.manifest])),
    builtinIds,

    async start() {
      for (const entry of plan) {
        if (!entry.enabled) continue;
        const { manifest, init } = usable.get(entry.id)!;
        const state = createModuleContext(manifest, options.sectionOf(entry.id), {
          env: options.env,
          foreignEnv: new Set([...envOwners].filter(([, owner]) => owner !== entry.id).map(([name]) => name)),
          logger,
          clock,
          registerProvider,
          providerStats: options.providerStats ?? listStats,
          staticKinds: staticKinds(),
          services: { offer: (name, impl) => services.offer(entry.id, name, impl), offers: serviceOffers },
          instances: instancesOf,
        });
        state.providerHandles.push(...(adopted.get(entry.id) ?? []));
        const startedAt = clock.now();
        try {
          await init(state.ctx);
        } catch (cause) {
          state.seal();
          // Stopped first, then the modules started before it, in reverse order.
          started.push({ id: entry.id, state });
          await stopAll();
          throw new ModuleInitError(entry.id, cause);
        }
        state.seal();
        started.push({ id: entry.id, state });
        services.publish(entry.id);
        logger.info({ event: "module.init", module: entry.id, durationMs: clock.now() - startedAt } satisfies ModuleInitEvent, "module initialised");
      }
      for (const { state } of started) for (const task of state.tasks) task.start();
    },

    mount(app, mountOptions = {}) {
      // Planning already disabled modules that collide with the kernel routes it was given.
      // This backstop checks the live table, so a kernel route the planner was not told about
      // fails loudly instead of silently winning (Hono's first registration wins).
      const kernel = app.routes.filter((route) => !isCatchAllMiddleware(route.path));
      const running = new Set(started.map(({ id }) => id));
      const reserved = new Set([...reservedRootPaths, ...(mountOptions.reservedRootPaths ?? [])]);
      for (const { id, state } of started) {
        const { manifest } = usable.get(id)!;
        for (const prefix of [`${MODULE_ROUTE_PREFIX}/${id}`, ...(manifest.contributes?.routes?.legacyAliases ?? [])]) {
          const clash = kernel.find((route) => patternReachesPrefix(route.path, prefix));
          if (clash) throw new ModuleManifestError(id, `route prefix "${prefix}" collides with kernel route ${clash.method} ${clash.path}`);
        }
        for (const path of state.rootRoutes.keys()) {
          if (reserved.has(path)) throw new ModuleManifestError(id, `root path "${path}" is reserved by the kernel`);
          const clash = kernel.find((route) => patternMatchesPath(route.path, path));
          if (clash) throw new ModuleManifestError(id, `root path "${path}" collides with kernel route ${clash.method} ${clash.path}`);
        }
      }
      // Modules installed but not running answer only their declared fixed responses.
      const off = [...usable.values()]
        .filter(({ manifest }) => !running.has(manifest.id) && (manifest.contributes?.routes?.whenDisabled?.length ?? 0) > 0)
        .map(({ manifest }) => manifest);
      for (const manifest of off) {
        for (const prefix of modulePrefixes(manifest)) {
          const clash = kernel.find((route) => patternReachesPrefix(route.path, prefix));
          if (clash) throw new ModuleManifestError(manifest.id, `route prefix "${prefix}" collides with kernel route ${clash.method} ${clash.path}`);
        }
      }
      for (const manifest of off) {
        const stub = disabledRoutes(manifest.contributes!.routes!.whenDisabled!);
        for (const prefix of modulePrefixes(manifest)) app.route(prefix, stub);
      }
      for (const { id, state } of started) {
        // A module that added no routes to its sub-app (a data source, say) gets no
        // `/api/m/<id>` or alias mount; root routes it registered are always served.
        if (state.hasHttpRoutes()) {
          app.route(`${MODULE_ROUTE_PREFIX}/${id}`, state.http);
          for (const alias of usable.get(id)!.manifest.contributes?.routes?.legacyAliases ?? []) {
            app.route(alias, state.http);
          }
        }
        for (const [path, handler] of state.rootRoutes) {
          app.all(path, (context) => inModuleRequest(() => handler(context.req.raw)));
        }
      }
    },

    rootPaths() {
      return declaredRootPaths;
    },

    health() {
      const snapshot: ModuleHealthSnapshot = { modules: {}, legacy: {} };
      const running = new Map(started.map(({ id, state }) => [id, state]));
      for (const id of [...seenIds].sort(compareText)) {
        const state = running.get(id);
        if (state === undefined) {
          snapshot.modules[id] = { state: "disabled", detail: disabled.get(id) ?? "not started" };
          continue;
        }
        const entry = readHealth(state, (usable.get(id)!.manifest.providerKinds ?? []).length > 0);
        snapshot.modules[id] = entry;
        const legacyKey = usable.get(id)!.manifest.health?.legacyKey;
        if (legacyKey !== undefined && entry.data !== undefined) snapshot.legacy[legacyKey] = entry.data;
      }
      return snapshot;
    },

    kindHandlers() {
      return kindRuntimes(
        enabledIds().map((id) => usable.get(id)!),
        options.env,
        (id, handle) => {
          const handles = adopted.get(id) ?? [];
          handles.push(handle);
          adopted.set(id, handles);
        },
        (id, reason) => {
          const index = plan.findIndex((entry) => entry.id === id && entry.enabled);
          if (index === -1) return;
          const message = `Module "${id}" was disabled: ${reason}.`;
          findings.push({ code: "MODULE_KIND_HANDLER_FAILED", severity: MODULE_HOST_FINDING_CATALOG.MODULE_KIND_HANDLER_FAILED.severity, path: findingPath(id), message });
          disabled.set(id, message);
          plan.splice(index, 1);
          // Disabled entries follow the enabled ones, in id order.
          const at = plan.findIndex((entry) => !entry.enabled && compareText(entry.id, id) > 0);
          plan.splice(at === -1 ? plan.length : at, 0, { id, enabled: false, reason: message });
          services.drop(id);
          logger.warn({ event: "module.disabled", module: id, reason: message, code: "MODULE_KIND_HANDLER_FAILED" } satisfies ModuleDisabledEvent, "module disabled");
        },
        envOwners,
        logger,
        builtinIds,
        (id, name, impl) => services.offer(id, name, impl),
      );
    },

    stop: stopAll,
  };
}

/** Freeze a value and everything reachable from it. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

const HEALTH_STATES = new Set(["ok", "degraded", "error"]);
const UNAVAILABLE = { state: "error", detail: "Module health unavailable" } as const;

/**
 * Call a module's health reporter and validate the whole report inside the isolation
 * boundary: a throw, a bad state or detail, or data that is not JSON yields the error
 * entry, so one module can never break `/api/health`.
 */
function readHealth(state: ModuleRuntimeState, dataSource: boolean): Exclude<ModuleHealthEntry, { state: "disabled" }> {
  if (state.reporter === null) {
    // A data source without a reporter: nothing in the estate asked it for a provider.
    return dataSource && state.providerHandles.length === 0 ? { state: "ok", detail: "not configured" } : { state: "ok" };
  }
  try {
    const health = state.reporter();
    if (health === null || typeof health !== "object" || !HEALTH_STATES.has(health.state)) return UNAVAILABLE;
    if (health.detail !== undefined && typeof health.detail !== "string") return UNAVAILABLE;
    return {
      state: health.state,
      ...(health.detail === undefined ? {} : { detail: health.detail }),
      ...(health.data === undefined ? {} : { data: jsonSnapshot(health.data) }),
    };
  } catch {
    return UNAVAILABLE;
  }
}

/**
 * Start modules, reporting an init failure like any other boot misconfiguration: the
 * classified message on stderr, then exit 2.
 */
export async function startModules(
  host: ModuleHost,
  exit: (code: 2) => never = (code) => process.exit(code),
  stderr: (text: string) => void = (text) => void process.stderr.write(text),
): Promise<void> {
  try {
    await host.start();
  } catch (cause) {
    stderr(`${(cause as Error).message}\n`);
    exit(2);
  }
}
