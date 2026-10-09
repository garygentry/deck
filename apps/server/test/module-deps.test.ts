import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { REPO_ROOT } from "./util/source-roots.js";

type Manifest = {
  name: string;
  exports?: unknown;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

const manifest = (dir: string): Manifest => JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as Manifest;
const declared = (pkg: Manifest): Record<string, string> => ({ ...pkg.dependencies, ...pkg.peerDependencies, ...pkg.devDependencies });

/**
 * Packages that must be one instance across the app and its built-in modules (a second React
 * breaks hooks; a second react-query, its client context; a second vitest, the test runner). A
 * module declares them as peers, plus dev dependencies for its own tests, never as its own.
 */
const SHARED = ["react", "react-dom", "@tanstack/react-query", "vitest"];

const HOSTS = ["apps/web", "apps/server"].map((dir) => ({ dir, pkg: manifest(join(REPO_ROOT, dir)) }));
const MODULES = readdirSync(join(REPO_ROOT, "modules"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(join(REPO_ROOT, "modules", entry.name, "package.json")))
  .map((entry) => ({ dir: `modules/${entry.name}`, pkg: manifest(join(REPO_ROOT, "modules", entry.name)) }));

describe("built-in module packages", () => {
  it("are found", () => {
    expect(MODULES.map(({ dir }) => dir)).toContain("modules/llm-usage");
  });

  it.each(MODULES)("$dir declares the shared packages as peers (with dev dependencies), never its own", ({ pkg }) => {
    for (const name of SHARED.filter((shared) => shared in declared(pkg))) {
      expect(pkg.dependencies?.[name], `${name} in dependencies`).toBeUndefined();
      expect(pkg.peerDependencies?.[name], `${name} in peerDependencies`).toBeDefined();
      expect(pkg.devDependencies?.[name], `${name} in devDependencies`).toBe(pkg.peerDependencies?.[name]);
    }
    // The hosts import a module's halves by path; a package entry point would be unused.
    expect(pkg.exports).toBeUndefined();
  });

  it.each(MODULES)("$dir resolves each package it shares with a host app to the host's own copy", ({ dir, pkg }) => {
    const shared = Object.keys(declared(pkg)).filter((name) => !name.startsWith("@deck/"));
    let compared = 0;
    for (const name of shared) {
      for (const host of HOSTS.filter((candidate) => name in declared(candidate.pkg))) {
        const mine = realpathSync(join(REPO_ROOT, dir, "node_modules", name));
        const theirs = realpathSync(join(REPO_ROOT, host.dir, "node_modules", name));
        expect(mine, `${dir}: ${name} vs ${host.dir}`).toBe(theirs);
        compared++;
      }
    }
    // A module that declares only workspace packages shares nothing with the hosts to compare.
    if (shared.length > 0) expect(compared).toBeGreaterThan(0);
  });
});
