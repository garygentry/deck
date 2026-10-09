/**
 * Runtime modules' web halves: `/modules/<id>/…` and `UiModule.web`, through the real server
 * composition (`boot()`) with the HTTP listener stubbed. A module's files answer exactly when
 * the UI manifest offers its web half; every other path under `/modules` is a plain 404.
 */

import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { UiManifest, UiModule } from "@deck/module-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stringify } from "yaml";

import { moduleDigest } from "../src/modules/runtime.js";
import { stopScheduler } from "../src/providers/registry.js";
import { boot, type BootHandle } from "../src/server/boot.js";

import { stubBun, unstubBun } from "./util/stub-bun.js";

vi.setConfig({ testTimeout: 30_000 });

const EXAMPLE = fileURLToPath(new URL("../../../examples/modules/maintenance", import.meta.url));
const WINDOWS = [{ name: "disk swap", start: "2999-01-01T02:00:00Z", durationMinutes: 30 }];

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
  stopScheduler();
  unstubBun();
  vi.restoreAllMocks();
  delete process.env.DECK_MODULES_DIR;
  delete process.env.DECK_MODULES_ENABLED;
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A config directory: a base layer, and `overlay` as an overlay layer (module sections are overlay-owned). */
function configDir(overlay: Record<string, unknown> = {}): string {
  const dir = tempDir("deck-rtw-cfg-");
  writeFileSync(join(dir, "00-base.yaml"), stringify({ schemaVersion: 2, estate: { name: "lab" } }));
  writeFileSync(join(dir, "10-overlay.yaml"), stringify({ schemaVersion: 2, ...overlay }));
  return dir;
}

type Request_ = (path: string, init?: RequestInit) => Promise<Response>;

async function bootOn(config: string, root: string, options: { enabled?: boolean; webDistDir?: string } = {}): Promise<Request_> {
  process.env.DECK_MODULES_DIR = root;
  if (options.enabled !== false) process.env.DECK_MODULES_ENABLED = "true";
  let fetchHandler: ((request: Request) => Response | Promise<Response>) | undefined;
  stubBun({
    serve: (serveOptions: { fetch: (request: Request) => Response | Promise<Response> }) => {
      fetchHandler = serveOptions.fetch;
      return { stop: async () => undefined };
    },
    // Static files: none (the SPA fallback serves the page).
    file: () => ({ exists: async () => false }),
  });
  const handle: BootHandle = await boot({ configDir: config, port: 0, uiReload: false, ...(options.webDistDir === undefined ? {} : { webDistDir: options.webDistDir }) });
  cleanup.push(() => handle.stop());
  return (path, init) => Promise.resolve(fetchHandler!(new Request(`http://deck${path}`, init)));
}

async function moduleOf(request: Request_, id: string): Promise<UiModule | undefined> {
  return ((await (await request("/api/ui")).json()) as UiManifest).modules.find((module) => module.id === id);
}

/** A modules root with a copy of the example module. */
function exampleRoot(): string {
  const root = tempDir("deck-rtw-mods-");
  cpSync(EXAMPLE, join(root, "maintenance"), { recursive: true });
  return root;
}

describe("a runtime module's web half", () => {
  it("is offered in /api/ui and served from /modules/<id>/, with the right types", async () => {
    const root = exampleRoot();
    const webDist = tempDir("deck-rtw-dist-");
    writeFileSync(join(webDist, "index.html"), "<!doctype html><title>Deck</title><div id=app></div>");
    const request = await bootOn(configDir({ modules: { maintenance: { windows: WINDOWS } } }), root, { webDistDir: webDist });

    expect((await moduleOf(request, "maintenance"))?.web).toEqual({ script: "/modules/maintenance/web.js", styles: "/modules/maintenance/web.css" });
    for (const [file, type] of [["web.js", "text/javascript"], ["web.css", "text/css"], ["deck-module.json", "application/json"]] as const) {
      const response = await request(`/modules/maintenance/${file}`);
      expect(response.status, file).toBe(200);
      expect(response.headers.get("content-type"), file).toContain(type);
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(await response.text(), file).toBe(readFileSync(join(EXAMPLE, file), "utf8"));
      // Revalidated by ETag.
      const again = await request(`/modules/maintenance/${file}`, { headers: { "If-None-Match": response.headers.get("etag")! } });
      expect(again.status).toBe(304);
    }
    // Only the web half's files, never the server entry, and never the SPA shell.
    for (const path of ["/modules/maintenance/server.mjs", "/modules/maintenance/missing.js", "/modules/maintenance/web.js/x", "/modules/maintenance", "/modules", "/modules/", "/modules/other/web.js"]) {
      const response = await request(path);
      expect(response.status, path).toBe(404);
      expect(await response.text(), path).not.toContain("<div id=app>");
    }
    // A page path still gets the SPA shell.
    expect(await (await request("/maintenance")).text()).toContain("<div id=app>");
  });

  it("serves the bytes read at load: a later change is not served", async () => {
    const root = exampleRoot();
    const request = await bootOn(configDir({ modules: { maintenance: { windows: WINDOWS } } }), root);
    writeFileSync(join(root, "maintenance", "web.js"), "export default 'changed';\n");
    expect(await (await request("/modules/maintenance/web.js")).text()).toBe(readFileSync(join(EXAMPLE, "web.js"), "utf8"));
  });

  it("has no styles entry without a web.css, and no web half without a web.js", async () => {
    const root = exampleRoot();
    rmSync(join(root, "maintenance", "web.css"));
    let request = await bootOn(configDir({ modules: { maintenance: { windows: WINDOWS } } }), root);
    expect((await moduleOf(request, "maintenance"))?.web).toEqual({ script: "/modules/maintenance/web.js" });
    expect((await request("/modules/maintenance/web.css")).status).toBe(404);
    await cleanup.pop()!();
    stopScheduler();

    rmSync(join(root, "maintenance", "web.js"));
    request = await bootOn(configDir({ modules: { maintenance: { windows: WINDOWS } } }), root);
    expect((await moduleOf(request, "maintenance"))?.enabled).toBe(true);
    expect((await moduleOf(request, "maintenance"))?.web).toBeUndefined();
    expect((await request("/modules/maintenance/deck-module.json")).status).toBe(404);
  });
});

describe("a module deck did not load: no web entry, and every file 404s", () => {
  const section = { modules: { maintenance: { windows: WINDOWS } } };
  type Setup = { config: Record<string, unknown>; enabled?: boolean };
  const cases: Array<[string, (root: string) => Setup]> = [
    ["the gate is off", () => ({ config: section, enabled: false })],
    ["it is off for want of its section (inert)", () => ({ config: {} })],
    ["its server entry fails to import", (root) => {
      writeFileSync(join(root, "maintenance", "server.mjs"), `throw new Error("boom");\n`);
      return { config: section };
    }],
    ["its directory does not match its pin", (root) => {
      const pin = moduleDigest(join(root, "maintenance"));
      writeFileSync(join(root, "maintenance", "web.js"), "export default null;\n");
      return { config: { ...section, moduleIntegrity: { maintenance: pin } } };
    }],
    ["its web.js resolves outside its directory", (root) => {
      const outside = tempDir("deck-rtw-out-");
      writeFileSync(join(outside, "web.js"), "export default null;\n");
      rmSync(join(root, "maintenance", "web.js"));
      // A symbolic link out of the module directory fails the module's load.
      symlinkSync(join(outside, "web.js"), join(root, "maintenance", "web.js"));
      return { config: section };
    }],
  ];

  for (const [label, arrange] of cases) {
    it(label, async () => {
      const root = exampleRoot();
      const setup = arrange(root);
      const request = await bootOn(configDir(setup.config), root, { enabled: setup.enabled !== false });
      const module = await moduleOf(request, "maintenance");
      expect(module?.enabled).toBe(false);
      expect(module?.web).toBeUndefined();
      for (const file of ["web.js", "web.css", "deck-module.json"]) expect((await request(`/modules/maintenance/${file}`)).status, file).toBe(404);
    });
  }

  it("and the same module, loaded, is offered and served (the control)", async () => {
    const root = exampleRoot();
    const pin = moduleDigest(join(root, "maintenance"));
    const request = await bootOn(configDir({ modules: { maintenance: { windows: WINDOWS } }, moduleIntegrity: { maintenance: pin } }), root);
    expect((await moduleOf(request, "maintenance"))?.web).toBeDefined();
    expect((await request("/modules/maintenance/web.js")).status).toBe(200);
  });
});

describe("module paths", () => {
  it("refuses a runtime module page or root path under /modules", async () => {
    const root = tempDir("deck-rtw-mods-");
    for (const [id, contributes] of [
      ["pathy", { pages: [{ id: "page:pathy/main", path: "/modules/pathy", title: "Pathy", component: "Main" }] }],
      ["rooty", { routes: { rootPaths: ["/modules/x"] } }],
    ] as const) {
      mkdirSync(join(root, id));
      writeFileSync(join(root, id, "deck-module.json"), JSON.stringify({ id, version: "1.0.0", deckApi: "^0.1", contributes }));
    }
    const request = await bootOn(configDir(), root);
    for (const id of ["pathy", "rooty"]) {
      const module = await moduleOf(request, id);
      expect(module?.enabled, id).toBe(false);
      expect(module?.reason, id).toMatch(/modules/);
    }
  });
});
