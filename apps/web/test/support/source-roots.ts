import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
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

/** `modules/<id>/<sub>` for every built-in module directory that has one. */
function moduleSubdirs(repo: string, sub: string): string[] {
  const modules = join(repo, "modules");
  if (!isDir(modules)) return [];
  return readdirSync(modules, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(modules, entry.name, sub))
    .filter(isDir)
    .sort();
}

/** Each built-in module's web half: `modules/<id>/web`, for every module directory that has one. */
export function moduleWebDirs(repo: string = REPO_ROOT): string[] {
  return moduleSubdirs(repo, "web");
}

/** Each built-in module's web tests: `modules/<id>/test/web`, for every module that has them. */
export function moduleWebTestDirs(repo: string = REPO_ROOT): string[] {
  return moduleSubdirs(repo, "test/web");
}

/**
 * The web app's own sources and every built-in module's web half: the code compiled into the
 * app, which the web's source guards hold to the same rules.
 */
export function webSourceRoots(repo: string = REPO_ROOT): string[] {
  return [join(repo, "apps/web/src"), ...moduleWebDirs(repo)];
}

/**
 * The web app's own tests and every built-in module's web tests: the directories the web test
 * suite collects from, which the web's test guards hold to the same rules.
 */
export function webTestRoots(repo: string = REPO_ROOT): string[] {
  return [join(repo, "apps/web/test"), ...moduleWebTestDirs(repo)];
}

/** Every file under the web source roots. */
export function webSourceFiles(repo: string = REPO_ROOT): string[] {
  return webSourceRoots(repo).flatMap(walkFiles);
}

/**
 * How a guard names a source file: relative to apps/web for the app's own (`src/ui/…`), and
 * repo-relative for a module's web half (`modules/<id>/web/…`).
 */
export function sourceRel(path: string, repo: string = REPO_ROOT): string {
  const web = join(repo, "apps/web");
  const fromWeb = relative(web, path);
  return fromWeb.startsWith("..") ? relative(repo, path) : fromWeb;
}
