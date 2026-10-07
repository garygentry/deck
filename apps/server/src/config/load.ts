import { readFileSync } from "node:fs";
import {
  classify,
  merge,
  MergeError,
  validate,
  type Finding,
  type JsonObject,
  type ValidationResult,
} from "@deck/schema";
import { parse as parseYaml } from "yaml";
import type { DeckConfig } from "../contract/config.js";
import { resolveConfigDir } from "./resolve-dir.js";

export type ExitClass = 0 | 1 | 2;

export interface ConfigDirError {
  code:
    | "CONFIG_DIR_MISSING"
    | "CONFIG_DIR_EMPTY"
    | "CONFIG_YAML_PARSE"
    | "CONFIG_MERGE_ERROR";
  message: string;
  path?: string;
}

export type LoaderResult =
  | { exitClass: 0; config: DeckConfig; findings: readonly Finding[] }
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
}

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

  const [first, ...overlays] = documents;
  const results: ValidationResult[] = [validate(first, { layer: "base" })];
  let accumulator = first;

  for (const overlay of overlays) {
    results.push(validate(overlay, { layer: "overlay", base: accumulator }));
    try {
      accumulator = merge(accumulator, overlay);
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

  results.push(validate(accumulator, { layer: "merged" }));
  const exitClass = maxClassification(results);
  const findings = collectFindings(results);
  if (exitClass === 2) {
    const failed = results.find((result) => result.classification === 2);
    return { exitClass: 2, config: null, findings, toolError: failed!.toolError };
  }
  if (exitClass === 1) return { exitClass: 1, config: null, findings };
  return { exitClass: 0, config: deepFreeze(accumulator) as unknown as DeckConfig, findings };
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
