// Check a production build of the web shell (`vite build --outDir <dir>`), for runtime modules:
// - the page has one import map, ahead of every module script and modulepreload link;
// - it maps react, react-dom, react/jsx-runtime and @deck/sdk, each to a file the build emitted;
// - the chunks hold exactly one copy of React and of React DOM, so a module importing through
//   the map shares the shell's.
// Usage: node apps/web/scripts/check-web-build.mjs <dist dir>
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dist = process.argv[2];
if (!dist) throw new Error("usage: check-web-build.mjs <dist dir>");
const problems = [];
const html = readFileSync(join(dist, "index.html"), "utf8");

const maps = [...html.matchAll(/<script type="importmap">([\s\S]*?)<\/script>/g)];
if (maps.length !== 1) problems.push(`expected one import map, found ${maps.length}`);
const map = maps[0];
if (map !== undefined) {
  const firstModule = html.search(/<script\b[^>]*type="module"|<link\b[^>]*rel="modulepreload"/);
  if (firstModule !== -1 && firstModule < map.index) problems.push("a module script or modulepreload link comes before the import map");
  const { imports = {} } = JSON.parse(map[1]);
  const expected = ["@deck/sdk", "react", "react-dom", "react/jsx-runtime"];
  if (JSON.stringify(Object.keys(imports).sort()) !== JSON.stringify(expected)) problems.push(`import map keys are ${Object.keys(imports).sort().join(", ")}`);
  for (const [specifier, url] of Object.entries(imports)) {
    if (typeof url !== "string" || !url.startsWith("/") || !existsSync(join(dist, url.slice(1)))) problems.push(`${specifier} maps to ${url}, which the build did not emit`);
  }
}

// Each package's internals are assigned once per copy of it.
const chunks = readdirSync(join(dist, "assets")).filter((name) => name.endsWith(".js")).map((name) => readFileSync(join(dist, "assets", name), "utf8"));
for (const [name, marker] of [
  ["React", "__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE="],
  ["React DOM", "__DOM_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE="],
]) {
  const copies = chunks.reduce((count, text) => count + text.split(marker).length - 1, 0);
  if (copies !== 1) problems.push(`expected one copy of ${name} across the chunks, found ${copies}`);
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`::error::${problem}`);
  process.exit(1);
}
console.log("web build: one import map ahead of every module script, its four specifiers emitted, one React");
