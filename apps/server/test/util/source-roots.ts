import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The repository root. */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

const isDir = (path: string): boolean => existsSync(path) && statSync(path).isDirectory();

/** Every file under `dir`, recursively (directories by their entry type, so a stray file never throws). */
export function walkFiles(dir: string): string[] {
  if (!isDir(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walkFiles(path) : entry.isFile() ? [path] : [];
  });
}

/**
 * The server's own sources and every built-in module's server half (`modules/<id>/server`): the
 * code the server runs, which its source guards hold to the same rules.
 */
export function serverSourceRoots(repo: string = REPO_ROOT): string[] {
  const modules = join(repo, "modules");
  const halves = isDir(modules)
    ? readdirSync(modules, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(modules, entry.name, "server"))
        .filter(isDir)
        .sort()
    : [];
  return [join(repo, "apps/server/src"), ...halves];
}

/** Every file under the server source roots. */
export function serverSourceFiles(repo: string = REPO_ROOT): string[] {
  return serverSourceRoots(repo).flatMap(walkFiles);
}
