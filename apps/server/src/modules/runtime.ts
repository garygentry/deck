import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { isDeckApiRange, satisfiesDeckApi, type ModuleManifest, type ServerModule } from "@deck/module-sdk";
import { parse as parseYaml } from "yaml";

import { parseBool } from "../config/env.js";
import { resolveConfigDir } from "../config/resolve-dir.js";
import { BUILTIN_MODULES } from "./builtin.js";
import { manifestProblem } from "./host.js";

/** The directory runtime modules are loaded from: one subdirectory per module, named by its id. */
export const MODULES_DIR_ENV = "DECK_MODULES_DIR";
/** Runtime modules run only while this is `true` or `1`; otherwise their code is never loaded. */
export const MODULES_ENABLED_ENV = "DECK_MODULES_ENABLED";
/** A runtime module's manifest file, in its directory. */
export const RUNTIME_MANIFEST_FILE = "deck-module.json";
/** Server entry file names, in the order they are looked for; a module has at most one. */
export const SERVER_ENTRY_FILES: readonly string[] = ["server.js", "server.mjs", "server.ts"];
/** An integrity pin: `sha256-` and the base64 digest {@link moduleDigest} computes. */
export const INTEGRITY_PATTERN = /^sha256-[A-Za-z0-9+/]{43}=$/;
/** How long a server entry may take to import (its top-level code included). */
export const DEFAULT_IMPORT_TIMEOUT_MS = 10_000;

/**
 * What config loading and the module host need to know about runtime modules beside the
 * modules themselves.
 */
export interface RuntimeModulePlan {
  /** Runtime modules whose code failed to load, by id, with the reason: MODULE_LOAD_FAILED. */
  readonly loadProblems: ReadonlyMap<string, string>;
  /**
   * The env switch every runtime module needs on as well as its own `enabledBy`, by id
   * ({@link MODULES_ENABLED_ENV}).
   */
  readonly envGates: ReadonlyMap<string, string>;
  /**
   * Runtime modules present by their manifest only, because their code was not loaded (not
   * enabled, refused from the manifest, or a load failure). They have no kind handlers.
   */
  readonly codeless: ReadonlySet<string>;
  /**
   * Set when only manifests were read (`deck validate`, `deck render`): a module present by its
   * manifest only is planned as boot would plan it, so a module that would run is validated as
   * running (its config rules and kind rules aside, which are code). Never set at boot.
   */
  readonly planOnly?: true;
}

export interface RuntimeModules extends RuntimeModulePlan {
  /** The directory read, absolute; undefined when {@link MODULES_DIR_ENV} is unset. */
  readonly dir: string | undefined;
  /** One module per subdirectory, in id order: loaded, or a manifest-only stand-in. */
  readonly modules: readonly ServerModule<any>[];
  /** Ids whose server code was imported (or that have none), in id order. */
  readonly loaded: readonly string[];
  /** The integrity pins the decisions were made against, by id (see {@link checkPins}). */
  readonly pins: ReadonlyMap<string, string>;
  /** Ids of the modules whose `modules.<id>` section the config had when the decisions were made. */
  readonly sections: ReadonlySet<string>;
}

/** The empty result: no runtime modules. */
export const NO_RUNTIME_MODULES: RuntimeModules = Object.freeze({
  dir: undefined,
  modules: [],
  loaded: [],
  loadProblems: new Map<string, string>(),
  envGates: new Map<string, string>(),
  codeless: new Set<string>(),
  pins: new Map<string, string>(),
  sections: new Set<string>(),
});

/** A module directory found under the modules directory, before any of its code runs. */
interface Candidate {
  id: string;
  dir: string;
  /** The parsed manifest; a minimal `{ id }` stand-in when it could not be read. */
  manifest: ModuleManifest;
  /** Why the directory cannot be loaded, when the manifest or entry is unusable. */
  problem: string | null;
  /** The server entry, absolute; null for a module without server code. */
  entry: string | null;
}

/** A thrown failure of a runtime module, with a message fit for a finding. */
class LoadError extends Error {}

/**
 * The integrity digest of a module directory: sha256 over every regular file below it, in
 * path order, each as `<path>\0<sha256 hex of its bytes>\n` with `/`-separated relative paths.
 * Written `sha256-<base64>`, the form an integrity pin takes. A symbolic link or any other
 * entry that is neither a file nor a directory makes it throw, since what it points at is
 * outside what the digest covers.
 */
export function moduleDigest(dir: string): string {
  const outer = createHash("sha256");
  const walk = (current: string) => {
    for (const name of readdirSync(current).sort()) {
      const path = join(current, name);
      const stats = lstatSync(path);
      const rel = relative(dir, path).split(sep).join("/");
      if (stats.isDirectory()) walk(path);
      else if (stats.isFile()) outer.update(`${rel}\0${createHash("sha256").update(readFileSync(path)).digest("hex")}\n`);
      else throw new LoadError(`"${rel}" is not a regular file or directory, so the integrity digest cannot cover it`);
    }
  };
  walk(realpathSync(dir));
  return `sha256-${outer.digest("base64")}`;
}

/** Read every module directory under `root` (data only: no module code runs). */
function discover(root: string): Candidate[] {
  const candidates: Candidate[] = [];
  // Hidden entries are skipped: a Kubernetes volume keeps its `..data` links there.
  for (const id of readdirSync(root).filter((name) => !name.startsWith(".")).sort()) {
    const dir = join(root, id);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    const stub = { id, version: "unknown", deckApi: "0" } as ModuleManifest;
    let manifest: unknown;
    try {
      manifest = JSON.parse(readFileSync(join(dir, RUNTIME_MANIFEST_FILE), "utf8"));
    } catch (cause) {
      const reason = (cause as NodeJS.ErrnoException).code === "ENOENT"
        ? `${RUNTIME_MANIFEST_FILE} is missing`
        : `${RUNTIME_MANIFEST_FILE} is not valid JSON: ${(cause as Error).message}`;
      candidates.push({ id, dir, manifest: stub, problem: reason, entry: null });
      continue;
    }
    if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
      candidates.push({ id, dir, manifest: stub, problem: `${RUNTIME_MANIFEST_FILE} is not a JSON object`, entry: null });
      continue;
    }
    const declared = (manifest as { id?: unknown }).id;
    if (declared !== id) {
      candidates.push({ id, dir, manifest: stub, problem: `${RUNTIME_MANIFEST_FILE} declares id ${JSON.stringify(declared)}, but its directory is "${id}"`, entry: null });
      continue;
    }
    const entries = SERVER_ENTRY_FILES.filter((name) => {
      try {
        return statSync(join(dir, name)).isFile();
      } catch {
        return false;
      }
    });
    if (entries.length > 1) {
      candidates.push({ id, dir, manifest: manifest as ModuleManifest, problem: `it has more than one server entry (${entries.join(", ")})`, entry: null });
      continue;
    }
    candidates.push({ id, dir, manifest: deepFreeze(manifest) as ModuleManifest, problem: null, entry: entries[0] === undefined ? null : join(dir, entries[0]) });
  }
  return candidates;
}

/**
 * What the config says before it is validated: each layer's integrity pins (a later layer's
 * pin for an id replacing an earlier one's, as the merge does) and which modules have a
 * section. Null when the directory cannot be read or parsed; config loading then reports why.
 */
export function readConfigHints(configDir: string | undefined, env: Readonly<Record<string, string | undefined>>): { pins: Map<string, unknown>; sections: Set<string> } | null {
  const resolved = resolveConfigDir({ ...(configDir === undefined ? {} : { arg: configDir }), env: { ...env } });
  if (!resolved.ok) return null;
  const pins = new Map<string, unknown>();
  const sections = new Set<string>();
  for (const file of resolved.files) {
    let document: unknown;
    try {
      document = parseYaml(readFileSync(file, "utf8"));
    } catch {
      return null;
    }
    if (document === null || typeof document !== "object") continue;
    const { moduleIntegrity, modules } = document as { moduleIntegrity?: unknown; modules?: unknown };
    if (moduleIntegrity !== null && typeof moduleIntegrity === "object") {
      for (const [id, pin] of Object.entries(moduleIntegrity)) pins.set(id, pin);
    }
    if (modules !== null && typeof modules === "object") for (const id of Object.keys(modules)) sections.add(id);
  }
  return { pins, sections };
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

/** A manifest-only stand-in for a runtime module whose code is not loaded; its init never runs. */
function standIn(manifest: ModuleManifest): ServerModule {
  return Object.freeze({ manifest, init: () => {} });
}

/** The default export of a server entry as a server module, checked against its manifest file. */
function asServerModule(exported: unknown, manifest: ModuleManifest, entry: string): ServerModule {
  const name = entry.split(sep).pop();
  if (exported === null || typeof exported !== "object") {
    throw new LoadError(`${name} has no default export of a server module ({ manifest, init })`);
  }
  const { manifest: declared, init, configRules, kinds } = exported as Partial<ServerModule>;
  if (typeof init !== "function") throw new LoadError(`${name}'s default export has no init function`);
  // The manifest file is what config and the UI are planned from, so the code must agree.
  let same: boolean;
  try {
    same = isDeepStrictEqual(JSON.parse(JSON.stringify(declared ?? null)), manifest);
  } catch {
    same = false;
  }
  if (!same) throw new LoadError(`${name}'s manifest differs from ${RUNTIME_MANIFEST_FILE}`);
  if (configRules !== undefined && (!Array.isArray(configRules) || configRules.some((rule) => typeof rule !== "function"))) {
    throw new LoadError(`${name}'s configRules must be a list of functions`);
  }
  if (kinds !== undefined && (kinds === null || typeof kinds !== "object" || Array.isArray(kinds))) {
    throw new LoadError(`${name}'s kinds must be an object of kind handlers`);
  }
  return Object.freeze({
    manifest,
    init,
    ...(configRules === undefined ? {} : { configRules: Object.freeze([...configRules]) }),
    ...(kinds === undefined ? {} : { kinds }),
  });
}

/** Import `entry` within `timeoutMs`; a module whose top-level code never settles fails. */
async function importWithin(entry: string, timeoutMs: number, importer: (url: string) => Promise<unknown>): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new LoadError(`its server entry did not finish loading within ${timeoutMs} ms`)), timeoutMs);
  });
  try {
    return await Promise.race([importer(pathToFileURL(entry).href), timeout]);
  } finally {
    clearTimeout(timer);
  }
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

/** Discovery and every decision made before any import: what {@link loadRuntimeModules} imports. */
interface Prepared {
  result: RuntimeModules & { modules: ServerModule<any>[]; loaded: string[]; loadProblems: Map<string, string>; codeless: Set<string> };
  /** Candidates cleared to import, each with its index in `result.modules` (a placeholder until loaded). */
  pending: { candidate: Candidate & { entry: string }; index: number }[];
}

function prepare(options: Pick<LoadRuntimeOptions, "env" | "configDir">, importCode: boolean): Prepared {
  const { env } = options;
  const root = env[MODULES_DIR_ENV];
  const empty = (): Prepared => ({
    result: { ...NO_RUNTIME_MODULES, modules: [], loaded: [], loadProblems: new Map(), codeless: new Set(), ...(root ? { dir: root } : {}) },
    pending: [],
  });
  if (root === undefined || root === "") return empty();
  const on = parseBool(env[MODULES_ENABLED_ENV], false);
  let candidates: Candidate[];
  try {
    candidates = discover(root);
  } catch (cause) {
    // Off, an unreadable directory is ignored: nothing from it would run anyway.
    if (!on) return empty();
    throw new Error(`${MODULES_DIR_ENV} ${root} cannot be read: ${(cause as Error).message}`);
  }

  const hints = readConfigHints(options.configDir, env);
  const modules: ServerModule<any>[] = [];
  const loaded: string[] = [];
  const loadProblems = new Map<string, string>();
  const envGates = new Map<string, string>();
  const codeless = new Set<string>();
  const pins = new Map<string, string>();
  const pending: Prepared["pending"] = [];
  const fail = (candidate: Candidate, reason: string) => {
    loadProblems.set(candidate.id, `${candidate.dir}: ${reason}`);
    codeless.add(candidate.id);
    modules.push(standIn(candidate.manifest));
  };

  for (const candidate of candidates) {
    const { id, manifest } = candidate;
    envGates.set(id, MODULES_ENABLED_ENV);
    if (candidate.problem !== null) {
      fail(candidate, candidate.problem);
      continue;
    }
    // Switched off, refused from the manifest, or the config cannot be read (loading reports
    // why): no code runs, and the host says why the module is off.
    const { enabledBy } = manifest;
    const wouldRun = on && importCode && hints !== null
      && manifestProblem(manifest, []) === null
      && isDeckApiRange(manifest.deckApi) && satisfiesDeckApi(manifest.deckApi)
      && (enabledBy?.config !== true || hints.sections.has(id))
      && (enabledBy?.env === undefined || parseBool(env[enabledBy.env], false));
    if (!wouldRun) {
      codeless.add(id);
      modules.push(standIn(manifest));
      continue;
    }

    const pin = hints.pins.get(id);
    if (pin !== undefined) {
      if (typeof pin !== "string" || !INTEGRITY_PATTERN.test(pin)) {
        fail(candidate, "its integrity pin is not a sha256-<base64> digest");
        continue;
      }
      pins.set(id, pin);
      let digest: string;
      try {
        digest = moduleDigest(candidate.dir);
      } catch (cause) {
        fail(candidate, cause instanceof LoadError ? cause.message : `its directory cannot be read: ${(cause as Error).message}`);
        continue;
      }
      if (digest !== pin) {
        fail(candidate, `its directory digest ${digest} does not match the pinned ${pin}`);
        continue;
      }
    }

    if (candidate.entry === null) {
      // No server code: a module of manifest contributions only.
      modules.push(Object.freeze({ manifest, init: () => {} }));
      loaded.push(id);
      continue;
    }
    pending.push({ candidate: candidate as Candidate & { entry: string }, index: modules.length });
    modules.push(standIn(manifest));
  }
  return {
    result: { dir: root, modules, loaded, loadProblems, envGates, codeless, pins, sections: hints?.sections ?? new Set() },
    pending,
  };
}

/**
 * Discover and load the runtime modules in {@link MODULES_DIR_ENV}. Every subdirectory
 * becomes one module, so its `modules.<id>` section is known to config validation whatever
 * happens to its code.
 *
 * Code is imported only for a module that would run: {@link MODULES_ENABLED_ENV} is on, its
 * manifest passes the host's checks, its `deckApi` range is satisfied, its own `enabledBy`
 * holds, and its directory matches its integrity pin, if the config has one. Any other module
 * stands in by its manifest alone; the host then reports why it is off. A module whose
 * manifest cannot be read, whose pin does not match, or whose entry fails to import (or to
 * export a server module whose manifest equals `deck-module.json`) is a load failure: the host
 * disables it with MODULE_LOAD_FAILED and boot continues.
 *
 * Throws a plain Error only for a deployment deck cannot start with: the modules directory is
 * set, runtime modules are on, and the directory cannot be read.
 */
export async function loadRuntimeModules(options: LoadRuntimeOptions): Promise<RuntimeModules> {
  const { result, pending } = prepare(options, true);
  const importer = options.importer ?? ((url: string) => import(url));
  const timeoutMs = options.importTimeoutMs ?? DEFAULT_IMPORT_TIMEOUT_MS;
  for (const { candidate, index } of pending) {
    const { id, manifest } = candidate;
    try {
      const realDir = realpathSync(candidate.dir);
      const realEntry = realpathSync(candidate.entry);
      if (!realEntry.startsWith(`${realDir}${sep}`)) throw new LoadError("its server entry resolves outside the module directory");
      const namespace = await importWithin(realEntry, timeoutMs, importer);
      result.modules[index] = asServerModule((namespace as { default?: unknown } | null)?.default, manifest, realEntry);
      result.loaded.push(id);
    } catch (cause) {
      result.loadProblems.set(id, `${candidate.dir}: ${cause instanceof LoadError ? cause.message : `its server entry failed to import: ${(cause as Error)?.message ?? String(cause)}`}`);
      result.codeless.add(id);
    }
  }
  result.loaded.sort();
  return result;
}

/**
 * The runtime modules by manifest only, for `deck validate` and `deck render`: their sections
 * are known and checked against their manifests' schemas, and no module code runs (so their
 * config rules do not either).
 */
export function readRuntimeManifests(options: Pick<LoadRuntimeOptions, "env" | "configDir">): RuntimeModules {
  return { ...prepare(options, false).result, planOnly: true };
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
