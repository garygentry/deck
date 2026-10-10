import { readFileSync } from "node:fs";
import {
  classify,
  ComposeError,
  merge,
  MergeError,
  MIGRATABLE_CONFIG_VERSION,
  MODULE_HOST_FINDING_CATALOG,
  validate,
  type ComposedConfig,
  type DisabledSections,
  type Finding,
  type JsonObject,
  type ValidationResult,
} from "@deck/schema";
import { parse as parseYaml } from "yaml";
import type { DeckConfig } from "../contract/config.js";
import type { ServerModule } from "@deck/module-sdk";
import { builtinComposition, composeModules, credentialEnvFindings, type CredentialOwners } from "../modules/config.js";
import { ModuleManifestError } from "../modules/host.js";
import type { RuntimeModulePlan } from "../modules/runtime.js";
import { planningRouteTable, RESERVED_ROOT_PATHS } from "../server/app.js";
import { resolveConfigDir } from "./resolve-dir.js";

export type ExitClass = 0 | 1 | 2;

export interface ConfigDirError {
  code:
    | "CONFIG_DIR_MISSING"
    | "CONFIG_DIR_EMPTY"
    | "CONFIG_YAML_PARSE"
    | "CONFIG_MERGE_ERROR"
    | "CONFIG_MIGRATION_REQUIRED";
  message: string;
  path?: string;
}

export type LoaderResult =
  | {
      exitClass: 0;
      config: DeckConfig;
      findings: readonly Finding[];
      /**
       * Modules config validation found broken (a contribution that does not compose, or a
       * config rule that failed), by id, with the reason. Boot disables them.
       */
      moduleProblems: ReadonlyMap<string, string>;
    }
  | { exitClass: 1; config: null; findings: readonly Finding[] }
  | {
      exitClass: 2;
      config: null;
      findings: readonly Finding[];
      toolError: ConfigDirError | { code: string; message: string };
    };

export interface LoadOptions {
  arg?: string;
  env?: Record<string, string | undefined>;
  cwd?: string;
  /** The config contract to validate against; default: composed from `modules`. */
  composed?: ComposedConfig;
  /** The server modules config is composed for; default: the built-in modules. */
  modules?: readonly ServerModule<any>[];
  /** How the runtime modules among `modules` loaded (see `loadRuntimeModules`). */
  runtime?: RuntimeModulePlan;
  /**
   * How a section for a module that will not run is checked. `advisory` (default, what boot
   * uses: a switched-off module never blocks boot): its problems are info findings.
   * `strict` (what `deck validate` uses): they keep their real severity.
   */
  disabledSections?: DisabledSections;
  /**
   * Loading for boot: `boot.ts`, and `deck render`, which renders the document boot serves
   * (`deck validate` never sets it). Findings that only advise ({@link BOOT_ADVISORY_CODES})
   * are reported as info, so they never stop the server or its render.
   */
  boot?: boolean;
}

/**
 * Warnings `deck validate` reports that do not stop boot: deck runs, and either a later step
 * fails on a real clash (a provider id shared across collections fails registration only if
 * both really register) or boot logs a warn line (a refused credentialEnv).
 */
export const BOOT_ADVISORY_CODES: ReadonlySet<string> = new Set(["PROVIDER_ID_SHARED", "MODULE_CREDENTIAL_ENV_REFUSED"]);

export function load(options: LoadOptions = {}): LoaderResult {
  const resolved = resolveConfigDir(options);
  if (!resolved.ok) {
    return { exitClass: 2, config: null, findings: [], toolError: resolved.error };
  }

  const documents: JsonObject[] = [];
  for (const file of resolved.files) {
    try {
      documents.push(parseYaml(readFileSync(file, "utf8")) as JsonObject);
    } catch (error) {
      return {
        exitClass: 2,
        config: null,
        findings: [],
        toolError: {
          code: "CONFIG_YAML_PARSE",
          message: `Failed to parse ${file}: ${errorMessage(error)}`,
          path: file,
        },
      };
    }
  }

  // A v1 layer anywhere means the directory predates modules: say how to migrate it before
  // anything else (a v1 base under a v2 overlay would otherwise read as a merge error).
  const v1 = documents.findIndex((document) => document?.schemaVersion === MIGRATABLE_CONFIG_VERSION);
  if (v1 !== -1) {
    return {
      exitClass: 2,
      config: null,
      findings: [],
      toolError: {
        code: "CONFIG_MIGRATION_REQUIRED",
        message: `${resolved.files[v1]} is schemaVersion ${MIGRATABLE_CONFIG_VERSION}; rewrite the directory with: deck config migrate ${resolved.dir}`,
      },
    };
  }

  // Compose the contract for the modules that will run: enablement can depend on whether a
  // layer has the module's section, and on the environment.
  let composed: ComposedConfig;
  let invalidModules: ReadonlyMap<string, string> = new Map();
  // Only when deck composed the contract itself: a caller-supplied one carries no module plan.
  let credentials: CredentialOwners | undefined;
  try {
    if (options.composed !== undefined) {
      composed = options.composed;
    } else {
      // Planned exactly as boot plans the host (the same kernel route table and reserved
      // paths), so validation checks the modules that will run and only those.
      const context = {
        sectionOf: (id: string) => (documents.some((document) => hasSection(document, id)) ? {} : undefined),
        env: options.env ?? process.env,
        kernelRoutes: planningRouteTable(),
        reservedRootPaths: RESERVED_ROOT_PATHS,
        ...(options.runtime === undefined ? {} : { runtime: options.runtime }),
      };
      const composition = options.modules === undefined
        ? builtinComposition(context)
        : composeModules(options.modules, context);
      composed = composition.composed;
      invalidModules = composition.invalid;
      credentials = composition.credentials;
    }
  } catch (error) {
    if (!(error instanceof ComposeError) && !(error instanceof ModuleManifestError)) throw error;
    return { exitClass: 2, config: null, findings: [], toolError: { code: error.code, message: error.message } };
  }

  const [first, ...overlays] = documents;
  const disabledSections = options.disabledSections ?? "advisory";
  let results: ValidationResult[] = [validate(first, { layer: "base", composed, disabledSections })];
  let accumulator = first;

  for (const overlay of overlays) {
    results.push(validate(overlay, { layer: "overlay", base: accumulator, composed, disabledSections }));
    try {
      accumulator = merge(accumulator, overlay, composed);
    } catch (error) {
      if (!(error instanceof MergeError)) throw error;
      return {
        exitClass: 2,
        config: null,
        findings: collectFindings(results),
        toolError: {
          code: "CONFIG_MERGE_ERROR",
          message: `${error.code} at ${error.path || "/"} (layer: ${error.layer}) — ${error.message}`,
          path: error.path,
        },
      };
    }
  }

  results.push(validate(accumulator, { layer: "merged", composed, disabledSections, env: options.env ?? process.env }));
  // A refused instance credential: what boot logs as a warning, reported against the merged config.
  const boot = options.boot === true;
  const refused = [
    ...(credentials === undefined ? [] : credentialEnvFindings(accumulator, credentials, { boot, disabledSections })),
    ...runtimeLoadFindings(options.runtime, boot),
  ];
  if (boot) results = results.map((result) => (result.classification === 2 ? result : { ...result, findings: result.findings.map(advisory) }));
  const exitClass = Math.max(maxClassification(results), classify(refused)) as ExitClass;
  const findings = [...collectFindings(results), ...refused];
  if (exitClass === 2) {
    const failed = results.find((result) => result.classification === 2);
    return { exitClass: 2, config: null, findings, toolError: failed!.toolError };
  }
  if (exitClass === 1) return { exitClass: 1, config: null, findings };
  const moduleProblems = new Map(invalidModules);
  for (const finding of findings) {
    if (finding.code !== "MODULE_RULE_FAILED") continue;
    const id = finding.module ?? finding.path.split("/")[2]!.replaceAll("~1", "/").replaceAll("~0", "~");
    if (!moduleProblems.has(id)) moduleProblems.set(id, finding.message);
  }
  return { exitClass: 0, config: deepFreeze(accumulator) as unknown as DeckConfig, findings, moduleProblems };
}

/**
 * Planning from manifests only (`deck validate`, `deck render`): each runtime module that would
 * fail to load (an integrity pin that does not match, say) as MODULE_LOAD_FAILED. Boot logs
 * these from the module host instead, and goes on, so for boot they are info.
 */
function runtimeLoadFindings(runtime: RuntimeModulePlan | undefined, boot: boolean): Finding[] {
  if (runtime?.planOnly !== true) return [];
  const { severity, fix } = MODULE_HOST_FINDING_CATALOG.MODULE_LOAD_FAILED;
  return [...runtime.loadProblems].map(([id, category]) => ({
    code: "MODULE_LOAD_FAILED",
    severity: boot ? "info" : severity,
    path: `/modules/${id}`,
    message: `Module "${id}" failed to load: ${category}.`,
    hint: runtime.loadDetails?.get(id) ?? fix,
  }));
}

/** A boot-advisory finding as info. */
function advisory(finding: Finding): Finding {
  return BOOT_ADVISORY_CODES.has(finding.code) && finding.severity !== "info" ? { ...finding, severity: "info" } : finding;
}

function hasSection(document: unknown, id: string): boolean {
  if (document === null || typeof document !== "object") return false;
  const modules = (document as { modules?: unknown }).modules;
  return modules !== null && typeof modules === "object" && Object.prototype.hasOwnProperty.call(modules, id);
}

export function maxClassification(results: readonly ValidationResult[]): ExitClass {
  return results.reduce<ExitClass>((maximum, result) => {
    const current = result.classification === 2 ? 2 : classify(result.findings);
    return current > maximum ? current : maximum;
  }, 0);
}

export function collectFindings(results: readonly ValidationResult[]): readonly Finding[] {
  return results.flatMap((result) => result.classification === 2 ? [] : result.findings);
}

export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
