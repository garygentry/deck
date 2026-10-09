import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import type { ModuleManifest, ServerModule } from "@deck/module-sdk";
import { ComposeError, merge, type JsonObject } from "@deck/schema";
import { parse as parseYaml } from "yaml";

import { parseBool } from "../config/env.js";
import { resolveConfigDir } from "../config/resolve-dir.js";
import { planningRouteTable, RESERVED_ROOT_PATHS } from "../server/app.js";
import { BUILTIN_MODULES } from "./builtin.js";
import { composeModules } from "./config.js";
import { ModuleManifestError, planModules } from "./host.js";

/** The directory runtime modules are loaded from: one subdirectory per module, named by its id. */
export const MODULES_DIR_ENV = "DECK_MODULES_DIR";
/** Runtime modules run only while this is `true` or `1`; otherwise their code is never loaded. */
export const MODULES_ENABLED_ENV = "DECK_MODULES_ENABLED";
/** A runtime module's manifest file, in its directory. */
export const RUNTIME_MANIFEST_FILE = "deck-module.json";
/** Server entry file names; a module has at most one. */
export const SERVER_ENTRY_FILES: readonly string[] = ["server.js", "server.mjs", "server.ts"];
/** An integrity pin: `sha256-` and the base64 digest {@link moduleDigest} computes. */
export const INTEGRITY_PATTERN = /^sha256-[A-Za-z0-9+/]{43}=$/;
/** How long a server entry may take to import (its top-level code included). */
export const DEFAULT_IMPORT_TIMEOUT_MS = 10_000;
/** Bounds on `deck-module.json`: its size in bytes, and how deep its JSON nests. */
export const MAX_MANIFEST_BYTES = 64 * 1024;
export const MAX_MANIFEST_DEPTH = 32;

/**
 * Why a runtime module failed to load, as the HTTP API may show it: a fixed category, never
 * the module's own error text or a file path (those go to the log only).
 */
export type LoadCategory = "bad manifest" | "outside DECK_MODULES_DIR" | "collision" | "pin mismatch" | "import error";

/**
 * What config loading and the module host need to know about runtime modules beside the
 * modules themselves.
 */
export interface RuntimeModulePlan {
  /** Runtime modules that failed to load, by id, with the category: MODULE_LOAD_FAILED. */
  readonly loadProblems: ReadonlyMap<string, string>;
  /** The full cause of each load failure, by id, for the log only. */
  readonly loadDetails?: ReadonlyMap<string, string>;
  /**
   * The env switch every runtime module needs on as well as its own `enabledBy`, by id
   * ({@link MODULES_ENABLED_ENV}). While it is off the module is inert.
   */
  readonly envGates: ReadonlyMap<string, string>;
  /** Runtime modules present by their manifest only: their code was not loaded. */
  readonly codeless: ReadonlySet<string>;
  /**
   * Planning only, never at boot: a module present by its manifest only plans as it would
   * once loaded, so a module that would run is validated as running (its code-level config
   * and kind rules aside). Set for `deck validate` and `deck render`, and while the loader
   * decides what to import.
   */
  readonly planOnly?: true;
}

export interface RuntimeModules extends RuntimeModulePlan {
  /** The modules directory as set; undefined when {@link MODULES_DIR_ENV} is unset. */
  readonly dir: string | undefined;
  /** One module per usable subdirectory, in id order: loaded, or a manifest-only stand-in. */
  readonly modules: readonly ServerModule<any>[];
  /** Ids whose server code was imported (or that have none), in id order. */
  readonly loaded: readonly string[];
  /** The integrity pins checked before an import, by id (see {@link checkPins}). */
  readonly pins: ReadonlyMap<string, string>;
  /** Ids of the modules whose `modules.<id>` section the config had when loading was decided. */
  readonly sections: ReadonlySet<string>;
  /** Directories left out entirely (named like a built-in or not plannable at all), each with why, for the log. */
  readonly rejected: readonly { id: string; detail: string }[];
}

/** The empty result: no runtime modules. */
export const NO_RUNTIME_MODULES: RuntimeModules = Object.freeze({
  dir: undefined,
  modules: [],
  loaded: [],
  loadProblems: new Map<string, string>(),
  loadDetails: new Map<string, string>(),
  envGates: new Map<string, string>(),
  codeless: new Set<string>(),
  pins: new Map<string, string>(),
  sections: new Set<string>(),
  rejected: [],
});

/** A failure of one runtime module: a public category, and the detail for the log. */
class LoadError extends Error {
  constructor(readonly category: LoadCategory, detail: string) {
    super(detail);
  }
}

/** A runtime module whose import never settled: its code may still be running, so boot stops. */
class FatalLoadError extends Error {}

/** A module directory under the modules directory, before any of its code runs. */
interface Candidate {
  id: string;
  /** Its real path, inside the modules directory (or as found, when it escapes). */
  dir: string;
  /** The parsed, frozen manifest; null when it could not be read. */
  manifest: ModuleManifest | null;
  problem: LoadError | null;
  /** The server entry, absolute; null for a module without server code. */
  entry: string | null;
}

const inside = (parent: string, child: string) => child.startsWith(`${parent}${sep}`);

/**
 * The integrity digest of a module directory: sha256 over every regular file below it, in
 * path order, each as `<path>\0<sha256 hex of its bytes>\n` with `/`-separated paths relative
 * to the directory's real path (so the same tree digests the same however it is reached).
 * Written `sha256-<base64>`, the form an integrity pin takes. A symbolic link or any other
 * entry that is neither a file nor a directory makes it throw, since what it points at is
 * outside what the digest covers.
 */
export function moduleDigest(dir: string): string {
  const root = realpathSync(dir);
  const outer = createHash("sha256");
  const walk = (current: string) => {
    for (const name of readdirSync(current).sort()) {
      const path = join(current, name);
      const stats = lstatSync(path);
      const rel = relative(root, path).split(sep).join("/");
      if (stats.isDirectory()) walk(path);
      else if (stats.isFile()) outer.update(`${rel}\0${createHash("sha256").update(readFileSync(path)).digest("hex")}\n`);
      else throw new LoadError("pin mismatch", `"${rel}" is not a regular file or directory, so the integrity digest cannot cover it`);
    }
  };
  walk(root);
  return `sha256-${outer.digest("base64")}`;
}

/** Whether `value` nests no deeper than `max` (iteratively: a deep value cannot overflow the stack). */
function depthWithin(value: unknown, max: number): boolean {
  const stack: Array<[unknown, number]> = [[value, 1]];
  while (stack.length > 0) {
    const [current, depth] = stack.pop()!;
    if (current === null || typeof current !== "object") continue;
    if (depth > max) return false;
    for (const child of Object.values(current)) stack.push([child, depth + 1]);
  }
  return true;
}

function deepFreeze<T>(value: T): T {
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === null || typeof current !== "object" || Object.isFrozen(current)) continue;
    Object.freeze(current);
    stack.push(...Object.values(current));
  }
  return value;
}

/** Read one entry of the modules directory (data only); null when it is not a module directory. */
function examine(root: string, id: string): Candidate | null {
  const path = join(root, id);
  try {
    if (!statSync(path).isDirectory()) return null;
  } catch {
    return null;
  }
  const dir = realpathSync(path);
  const failed = (category: LoadCategory, detail: string, manifest: ModuleManifest | null = null): Candidate =>
    ({ id, dir, manifest, problem: new LoadError(category, detail), entry: null });
  if (!inside(root, dir)) return failed("outside DECK_MODULES_DIR", `${path} resolves to ${dir}, outside ${root}`);

  let file: string;
  try {
    file = realpathSync(join(dir, RUNTIME_MANIFEST_FILE));
  } catch {
    return failed("bad manifest", `${RUNTIME_MANIFEST_FILE} is missing`);
  }
  if (!inside(dir, file)) return failed("outside DECK_MODULES_DIR", `${RUNTIME_MANIFEST_FILE} resolves to ${file}, outside ${dir}`);
  if (statSync(file).size > MAX_MANIFEST_BYTES) return failed("bad manifest", `${RUNTIME_MANIFEST_FILE} is larger than ${MAX_MANIFEST_BYTES} bytes`);
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(file, "utf8"));
  } catch (cause) {
    return failed("bad manifest", `${RUNTIME_MANIFEST_FILE} is not valid JSON: ${(cause as Error).message}`);
  }
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) return failed("bad manifest", `${RUNTIME_MANIFEST_FILE} is not a JSON object`);
  if (!depthWithin(manifest, MAX_MANIFEST_DEPTH)) return failed("bad manifest", `${RUNTIME_MANIFEST_FILE} nests deeper than ${MAX_MANIFEST_DEPTH} levels`);
  const declared = (manifest as { id?: unknown }).id;
  if (declared !== id) return failed("bad manifest", `${RUNTIME_MANIFEST_FILE} declares id ${JSON.stringify(declared)}, but its directory is "${id}"`);
  const frozen = deepFreeze(manifest) as ModuleManifest;
  const entries = SERVER_ENTRY_FILES.filter((name) => {
    try {
      return statSync(join(dir, name)).isFile();
    } catch {
      return false;
    }
  });
  if (entries.length > 1) return failed("bad manifest", `it has more than one server entry (${entries.join(", ")})`, frozen);
  return { id, dir, manifest: frozen, problem: null, entry: entries[0] === undefined ? null : join(dir, entries[0]) };
}

/** Every module directory under `root` (a real path); one that cannot be examined is a failed candidate. */
function discover(root: string): Candidate[] {
  const candidates: Candidate[] = [];
  // Hidden entries are skipped: a Kubernetes volume keeps its `..data` links there.
  for (const id of readdirSync(root).filter((name) => !name.startsWith(".")).sort()) {
    try {
      const candidate = examine(root, id);
      if (candidate !== null) candidates.push(candidate);
    } catch (cause) {
      candidates.push({ id, dir: join(root, id), manifest: null, problem: new LoadError("bad manifest", `it cannot be read: ${(cause as Error)?.message ?? String(cause)}`), entry: null });
    }
  }
  return candidates;
}

/**
 * What the config says before it is validated: the merged document's integrity pins and the
 * modules with a section, the layers merged exactly as config loading merges them. Null when
 * the directory cannot be read, parsed or merged; config loading then reports why.
 */
export function readConfigHints(configDir: string | undefined, env: Readonly<Record<string, string | undefined>>): { pins: Map<string, unknown>; sections: Set<string> } | null {
  const resolved = resolveConfigDir({ ...(configDir === undefined ? {} : { arg: configDir }), env: { ...env } });
  if (!resolved.ok) return null;
  let merged: JsonObject | undefined;
  try {
    for (const file of resolved.files) {
      const document = parseYaml(readFileSync(file, "utf8")) as JsonObject;
      merged = merged === undefined ? document : merge(merged, document);
    }
  } catch {
    return null;
  }
  if (merged === null || typeof merged !== "object") return null;
  const { moduleIntegrity, modules } = merged as { moduleIntegrity?: unknown; modules?: unknown };
  const pins = new Map<string, unknown>(moduleIntegrity !== null && typeof moduleIntegrity === "object" ? Object.entries(moduleIntegrity) : []);
  const sections = new Set<string>(modules !== null && typeof modules === "object" ? Object.keys(modules) : []);
  return { pins, sections };
}

/** A manifest-only stand-in for a runtime module whose code is not loaded; its init never runs. */
function standIn(manifest: ModuleManifest): ServerModule {
  return Object.freeze({ manifest, init: () => {} });
}

/** The stand-in for a module none of whose manifest may be used: its id alone. */
function idOnly(id: string): ServerModule {
  return standIn(Object.freeze({ id, version: "unknown", deckApi: "0" }));
}

/** The default export of a server entry as a server module, checked against its manifest file. */
function asServerModule(exported: unknown, manifest: ModuleManifest, name: string): ServerModule {
  if (exported === null || typeof exported !== "object") {
    throw new LoadError("import error", `${name} has no default export of a server module ({ manifest, init })`);
  }
  const { manifest: declared, init, configRules, kinds } = exported as Partial<ServerModule>;
  if (typeof init !== "function") throw new LoadError("import error", `${name}'s default export has no init function`);
  // The manifest file is what config and the UI are planned from, so the code must agree.
  let same: boolean;
  try {
    same = isDeepStrictEqual(JSON.parse(JSON.stringify(declared ?? null)), manifest);
  } catch {
    same = false;
  }
  if (!same) throw new LoadError("import error", `${name}'s manifest differs from ${RUNTIME_MANIFEST_FILE}`);
  if (configRules !== undefined && (!Array.isArray(configRules) || configRules.some((rule) => typeof rule !== "function"))) {
    throw new LoadError("import error", `${name}'s configRules must be a list of functions`);
  }
  if (kinds !== undefined && (kinds === null || typeof kinds !== "object" || Array.isArray(kinds))) {
    throw new LoadError("import error", `${name}'s kinds must be an object of kind handlers`);
  }
  return Object.freeze({
    manifest,
    init,
    ...(configRules === undefined ? {} : { configRules: Object.freeze([...configRules]) }),
    ...(kinds === undefined ? {} : { kinds }),
  });
}

export interface LoadRuntimeOptions {
  env: Readonly<Record<string, string | undefined>>;
  /** The config directory boot reads (default: as config loading resolves it from `env`). */
  configDir?: string;
  /** Bound on importing each server entry (default {@link DEFAULT_IMPORT_TIMEOUT_MS}). */
  importTimeoutMs?: number;
  /** Load an entry by URL (default: `import()`); tests substitute it. */
  importer?: (url: string) => Promise<unknown>;
}

/** The loader's working state, which becomes the {@link RuntimeModules} result. */
class Loading {
  readonly modules = new Map<string, ServerModule<any>>();
  readonly candidates = new Map<string, Candidate>();
  readonly loaded: string[] = [];
  readonly loadProblems = new Map<string, LoadCategory>();
  readonly loadDetails = new Map<string, string>();
  readonly envGates = new Map<string, string>();
  readonly codeless = new Set<string>();
  readonly pins = new Map<string, string>();
  readonly rejected: { id: string; detail: string }[] = [];
  /** Modules whose config contribution does not compose on its own, from the admitting composition. */
  private invalid: ReadonlyMap<string, string> = new Map();

  constructor(
    readonly dir: string,
    readonly on: boolean,
    readonly env: Readonly<Record<string, string | undefined>>,
    readonly hints: ReturnType<typeof readConfigHints>,
  ) {}

  fail(id: string, problem: LoadError): void {
    this.loadProblems.set(id, problem.category);
    this.loadDetails.set(id, `${this.candidates.get(id)?.dir ?? id}: ${problem.message}`);
    this.codeless.add(id);
  }

  private context() {
    return {
      sectionOf: (id: string) => (this.hints?.sections.has(id) === true ? {} : undefined),
      env: this.env,
      kernelRoutes: planningRouteTable(),
      reservedRootPaths: RESERVED_ROOT_PATHS,
      runtime: { loadProblems: this.loadProblems, envGates: this.envGates, codeless: this.codeless, planOnly: true as const },
    };
  }

  /**
   * Compose config for the built-ins and `modules` as boot will (throws when they cannot
   * coexist), keeping what the module plan needs from it.
   */
  private compose(modules: readonly ServerModule<any>[]): void {
    this.invalid = composeModules([...BUILTIN_MODULES, ...modules], this.context()).invalid;
  }

  /** The module plan from manifests, as boot will plan it, with modules not yet loaded standing in. */
  plan() {
    return planModules({ modules: [...BUILTIN_MODULES, ...this.modules.values()], ...this.context(), manifestProblems: this.invalid, builtins: new Set(BUILTIN_MODULES) }).plan;
  }

  /**
   * Add every candidate as a stand-in. When they cannot all coexist, they are added one at a
   * time instead, and one that cannot coexist with the built-ins or the runtime modules added
   * before it (a finding code, provider kind, key or
   * path they already claim) is reduced to its id: a collision while runtime modules are on,
   * inert while they are off. A directory named like a built-in module is left out.
   */
  admit(candidates: readonly Candidate[]): void {
    const builtinIds = new Set(BUILTIN_MODULES.map((module) => module.manifest.id));
    const admitted: Candidate[] = [];
    for (const candidate of candidates) {
      const { id } = candidate;
      if (builtinIds.has(id)) {
        this.rejected.push({ id, detail: `${candidate.dir}: a built-in module is named "${id}"` });
        continue;
      }
      admitted.push(candidate);
      this.candidates.set(id, candidate);
      this.envGates.set(id, MODULES_ENABLED_ENV);
      this.codeless.add(id);
      // Off, runtime modules are inert: a problem only reduces the module to its id.
      if (candidate.problem !== null && this.on) this.fail(id, candidate.problem);
      this.modules.set(id, candidate.manifest === null || (candidate.problem !== null && !this.on) ? idOnly(id) : standIn(candidate.manifest));
    }
    // Usually nothing collides, and one composition of them all settles it.
    if (this.collides([...this.modules.values()]) === null) return;
    const modules = new Map(this.modules);
    this.modules.clear();
    for (const { id, dir } of admitted) {
      let module = modules.get(id)!;
      const collision = this.collides([...this.modules.values(), module]);
      if (collision !== null) {
        module = idOnly(id);
        // Not even its id can be planned (a kernel-reserved one, say): leave the directory out.
        if (this.collides([...this.modules.values(), module]) !== null) {
          this.rejected.push({ id, detail: `${dir}: ${collision}` });
          for (const set of [this.candidates, this.envGates, this.loadProblems, this.loadDetails]) set.delete(id);
          this.codeless.delete(id);
          continue;
        }
        if (this.on) this.fail(id, new LoadError("collision", collision));
      }
      this.modules.set(id, module);
    }
    // The composition of every module admitted, for the plan.
    this.compose([...this.modules.values()]);
  }

  private collides(modules: readonly ServerModule<any>[]): string | null {
    try {
      this.compose(modules);
      return null;
    } catch (cause) {
      if (cause instanceof ComposeError || cause instanceof ModuleManifestError) return cause.message;
      throw cause;
    }
  }

  /** Check a module's directory against its pin, now; throws a LoadError when it does not match. */
  checkPin(id: string): void {
    const pin = this.hints?.pins.get(id);
    if (pin === undefined) return;
    if (typeof pin !== "string" || !INTEGRITY_PATTERN.test(pin)) throw new LoadError("pin mismatch", "its integrity pin is not a sha256-<base64> digest");
    this.pins.set(id, pin);
    let digest: string;
    try {
      digest = moduleDigest(this.candidates.get(id)!.dir);
    } catch (cause) {
      throw cause instanceof LoadError ? cause : new LoadError("pin mismatch", `its directory cannot be read: ${(cause as Error).message}`);
    }
    if (digest !== pin) throw new LoadError("pin mismatch", `its directory digest ${digest} does not match the pinned ${pin}`);
  }

  /** The runtime modules the plan enables that are neither loaded nor attempted, in init order. */
  pending(attempted: ReadonlySet<string>): string[] {
    return this.plan()
      .filter((entry) => entry.enabled && this.candidates.has(entry.id) && this.codeless.has(entry.id) && !this.loadProblems.has(entry.id) && !attempted.has(entry.id))
      .map((entry) => entry.id);
  }

  result(planOnly: boolean): RuntimeModules {
    return {
      dir: this.dir,
      modules: [...this.modules.values()],
      loaded: [...this.loaded].sort(),
      loadProblems: this.loadProblems,
      loadDetails: this.loadDetails,
      envGates: this.envGates,
      codeless: this.codeless,
      pins: this.pins,
      sections: this.hints?.sections ?? new Set(),
      rejected: this.rejected,
      ...(planOnly ? { planOnly: true as const } : {}),
    };
  }
}

/** Discover and admit every module directory (data only); null when none is configured. */
function start(options: Pick<LoadRuntimeOptions, "env" | "configDir">): Loading | null {
  const { env } = options;
  const setting = env[MODULES_DIR_ENV];
  if (setting === undefined || setting === "") return null;
  const on = parseBool(env[MODULES_ENABLED_ENV], false);
  let candidates: Candidate[];
  try {
    const root = realpathSync(setting);
    if (!statSync(root).isDirectory()) throw new Error("not a directory");
    candidates = discover(root);
  } catch (cause) {
    // Off, an unreadable directory is ignored: nothing from it would run anyway.
    if (!on) return new Loading(setting, on, env, null);
    throw new Error(`${MODULES_DIR_ENV} ${setting} cannot be read: ${(cause as Error).message}`);
  }
  const loading = new Loading(setting, on, env, readConfigHints(options.configDir, env));
  loading.admit(candidates);
  return loading;
}

/**
 * Discover and load the runtime modules in {@link MODULES_DIR_ENV}. Every subdirectory becomes
 * one module (except one named like a built-in, which is left out), so its `modules.<id>`
 * section is known to config validation whatever happens to its code.
 *
 * While {@link MODULES_ENABLED_ENV} is off, runtime modules are inert stand-ins and no code is
 * imported. Otherwise the whole module plan is worked out from manifests, as boot will plan it
 * (built-ins, kernel routes and pages, switches, dependencies, env claims), and only the
 * runtime modules it enables are imported, in init order. Each one's directory is checked
 * against its integrity pin, if the config has one, just before its own import. A module that
 * fails to load is disabled (MODULE_LOAD_FAILED) and the plan is worked out again without it,
 * so a module that depends on it is never imported. Boot continues.
 *
 * Throws (boot exits 2) for an unreadable modules directory while runtime modules are on, and
 * for an import that does not settle within the bound, since its code may keep running.
 */
export async function loadRuntimeModules(options: LoadRuntimeOptions): Promise<RuntimeModules> {
  const loading = start(options);
  if (loading === null) return NO_RUNTIME_MODULES;
  if (!loading.on || loading.hints === null) return loading.result(false);
  const importer = options.importer ?? ((url: string) => import(url));
  const timeoutMs = options.importTimeoutMs ?? DEFAULT_IMPORT_TIMEOUT_MS;
  const attempted = new Set<string>();
  for (let next = loading.pending(attempted); next.length > 0; next = loading.pending(attempted)) {
    const id = next[0]!;
    attempted.add(id);
    const candidate = loading.candidates.get(id)!;
    try {
      // Immediately before the import, so an earlier module's import cannot change it unseen.
      loading.checkPin(id);
      if (candidate.entry === null) {
        // No server code: a module of manifest contributions only.
        loading.modules.set(id, standIn(candidate.manifest!));
      } else {
        const entry = realpathSync(candidate.entry);
        if (!inside(candidate.dir, entry)) throw new LoadError("outside DECK_MODULES_DIR", `its server entry resolves to ${entry}, outside the module directory`);
        const namespace = await importWithin(id, entry, timeoutMs, importer);
        loading.modules.set(id, asServerModule((namespace as { default?: unknown } | null)?.default, candidate.manifest!, entry.split(sep).pop()!));
      }
      loading.codeless.delete(id);
      loading.loaded.push(id);
    } catch (cause) {
      if (cause instanceof FatalLoadError) throw cause;
      loading.fail(id, cause instanceof LoadError ? cause : new LoadError("import error", `its server entry failed to import: ${(cause as Error)?.message ?? String(cause)}`));
    }
  }
  return loading.result(false);
}

/** Import `entry` within `timeoutMs`; one whose top-level code never settles stops boot. */
async function importWithin(id: string, entry: string, timeoutMs: number, importer: (url: string) => Promise<unknown>): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new FatalLoadError(`runtime module "${id}": its server entry did not finish loading within ${timeoutMs} ms, and its code may still be running; deck cannot start with it`)), timeoutMs);
  });
  try {
    return await Promise.race([importer(pathToFileURL(entry).href), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The runtime modules by manifest only, for `deck validate` and `deck render`: planned as boot
 * would plan them, and each module boot would import checked against its integrity pin (a
 * mismatch is MODULE_LOAD_FAILED). No module code runs, so code-level config rules do not.
 */
export function readRuntimeManifests(options: Pick<LoadRuntimeOptions, "env" | "configDir">): RuntimeModules {
  const loading = start(options);
  if (loading === null) return NO_RUNTIME_MODULES;
  if (loading.on && loading.hints !== null) {
    for (const id of loading.pending(new Set())) {
      try {
        loading.checkPin(id);
      } catch (cause) {
        loading.fail(id, cause as LoadError);
      }
    }
  }
  return loading.result(true);
}

/**
 * The `load` options that compose config with the runtime modules' manifests (no code runs),
 * as `deck validate` and `deck render` load: none when there are no runtime modules. Throws
 * as {@link loadRuntimeModules} does for an unreadable modules directory.
 */
export function manifestLoadOptions(configDir: string | undefined, env: Readonly<Record<string, string | undefined>> = process.env): { modules?: readonly ServerModule<any>[]; runtime?: RuntimeModulePlan } {
  const runtime = readRuntimeManifests({ env, ...(configDir === undefined ? {} : { configDir }) });
  return runtime.modules.length === 0 ? {} : { modules: [...BUILTIN_MODULES, ...runtime.modules], runtime };
}

/**
 * After config loading: the problem, if any, with having decided what to load from the config
 * as it was read before validation. Every pin and section the decisions read must be what the
 * validated config holds; otherwise the directory changed while deck was starting.
 */
export function checkPins(runtime: RuntimeModules, config: { moduleIntegrity?: Readonly<Record<string, string>>; modules?: Readonly<Record<string, unknown>> }): string | null {
  for (const module of runtime.modules) {
    const { id } = module.manifest;
    const pinned = runtime.pins.get(id);
    const validated = config.moduleIntegrity?.[id];
    if (pinned !== validated && (pinned !== undefined || runtime.loaded.includes(id))) {
      return `the integrity pin of runtime module "${id}" changed while deck was starting; restart deck`;
    }
    const hasSection = config.modules !== undefined && Object.prototype.hasOwnProperty.call(config.modules, id);
    if (hasSection !== runtime.sections.has(id)) {
      return `the modules.${id} section changed while deck was starting; restart deck`;
    }
  }
  return null;
}
