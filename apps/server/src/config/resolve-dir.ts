import { readdirSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { ConfigDirError } from "./load.js";

export interface ResolveDirInput {
  arg?: string;
  env?: Record<string, string | undefined>;
  cwd?: string;
}

export type ResolveDirResult =
  | { ok: true; dir: string; files: readonly string[] }
  | { ok: false; error: ConfigDirError };

export function resolveConfigDir(input: ResolveDirInput = {}): ResolveDirResult {
  const source = input.arg ?? (input.env ?? process.env).DECK_CONFIG_DIR ?? "./config";
  const dir = isAbsolute(source) ? source : resolve(input.cwd ?? process.cwd(), source);

  try {
    if (!statSync(dir).isDirectory()) return missing(dir);
    const files = readdirSync(dir)
      .filter((name) => /\.ya?ml$/i.test(name))
      .map((name) => join(dir, name))
      .sort();
    if (files.length === 0) {
      return {
        ok: false,
        error: { code: "CONFIG_DIR_EMPTY", message: `Config directory contains no YAML files: ${dir}`, path: dir },
      };
    }
    return { ok: true, dir, files };
  } catch {
    return missing(dir);
  }
}

function missing(dir: string): ResolveDirResult {
  return {
    ok: false,
    error: { code: "CONFIG_DIR_MISSING", message: `Config directory is missing or is not a directory: ${dir}`, path: dir },
  };
}
