import { spawnSync } from "node:child_process";
import { appendFileSync, cpSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { lintModule } from "@deck/sdk/lint";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The template builds a module directory deck can load (dist/hello/), and `deck-module lint`
 * passes it and fails a seeded violation.
 */

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const manifest = JSON.parse(readFileSync(join(ROOT, "deck-module.json"), "utf8")) as Record<string, unknown> & { id: string };
/** The build's module directory, named by the module's id. */
const OUT = join(ROOT, "dist", manifest.id);
/** The module's Tailwind prefix, as web.css imports the preset with it. */
const PREFIX = /@deck\/sdk\/tailwind"\s+prefix\((\w+)\)/.exec(readFileSync(join(ROOT, "src/web/web.css"), "utf8"))![1]!;

const run = (command: string, args: string[], cwd = ROOT) => spawnSync(command, args, { cwd, encoding: "utf8" });

/** Each bare or relative specifier a built ES module imports. */
const importsOf = (text: string): string[] => [...text.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)["']([^"']+)["']/g)].map((match) => match[1]!);

const temps: string[] = [];
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

beforeAll(() => {
  const built = run("pnpm", ["run", "build"]);
  expect(built.status, built.stderr).toBe(0);
}, 120_000);

describe("the build", () => {
  it("writes one module directory: the manifest, server.mjs, web.js and web.css", () => {
    expect(readdirSync(OUT).sort()).toEqual(["deck-module.json", "server.mjs", "web.css", "web.js"]);
    expect(JSON.parse(readFileSync(join(OUT, "deck-module.json"), "utf8"))).toEqual(manifest);
  });

  it("leaves web.js importing only deck's import map, with no React of its own", () => {
    const web = readFileSync(join(OUT, "web.js"), "utf8");
    expect(importsOf(web).sort()).toEqual(["@deck/sdk", "react/jsx-runtime"]);
    expect(web).not.toContain("__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE");
  });

  it("bundles the server half with no runtime import of deck, exporting the manifest deck loads", async () => {
    const server = readFileSync(join(OUT, "server.mjs"), "utf8");
    expect(importsOf(server)).toEqual([]);
    const module = (await import(pathToFileURL(join(OUT, "server.mjs")).href)) as { default: { manifest: unknown; init: unknown } };
    expect(module.default.manifest).toEqual(manifest);
    expect(typeof module.default.init).toBe("function");
  });

  it("styles with deck's tokens under the module's prefix, adding no Preflight", () => {
    const css = readFileSync(join(OUT, "web.css"), "utf8");
    const classes = [...css.matchAll(/\.([\w\\:-]+)\{/g)].map((match) => match[1]!);
    expect(classes.length).toBeGreaterThan(5);
    expect(classes.filter((name) => !name.startsWith(`${PREFIX}\\:`))).toEqual([]);
    expect(css).toContain(`.${PREFIX}\\:bg-muted{background-color:var(--muted)}`);
    expect(css).toContain(`.${PREFIX}\\:rounded-md{border-radius:var(--corner-md)}`);
    expect(css).not.toMatch(/@layer base\s*\{|box-sizing/);
  });
});

describe("deck-module lint", () => {
  it("passes the module directory the build wrote, as it is installed", () => {
    expect(lintModule(OUT)).toEqual([]);
  });

  it("passes the template, built", () => {
    expect(lintModule(ROOT)).toEqual([]);
    const cli = run("pnpm", ["run", "--silent", "lint"]);
    expect(cli.stdout).toContain("deck-module lint: no offences");
    expect(cli.status).toBe(0);
  });

  it("fails a copy of the template with a seeded violation, naming each offence", () => {
    const copy = mkdtempSync(join(tmpdir(), `deck-module-${manifest.id}-`));
    temps.push(copy);
    for (const name of ["deck-module.json", "package.json", "src", "dist"]) cpSync(join(ROOT, name), join(copy, name), { recursive: true });
    appendFileSync(
      join(copy, "src/web/HelloPill.tsx"),
      `\nimport { createRoot } from "react-dom/client";\nexport const Seeded = () => <p className="${PREFIX}:rounded" style={{ color: "#ff0000" }} />;\n`,
    );
    appendFileSync(join(copy, "src/web/web.css"), '@import "tailwindcss";\n');

    const rules = lintModule(copy).map(({ rule, file }) => `${rule} ${file}`);
    expect(rules.sort()).toEqual([
      "colour-literal src/web/HelloPill.tsx",
      "inline-style src/web/HelloPill.tsx",
      "module-css-import src/web/web.css",
      "module-import src/web/HelloPill.tsx",
      "radius-scale src/web/HelloPill.tsx",
    ]);
    const cli = run(join(ROOT, "node_modules/.bin/deck-module"), ["lint", copy]);
    expect(cli.status).toBe(1);
    expect(cli.stderr).toContain("deck-module lint: 5 offences");
  });
});
