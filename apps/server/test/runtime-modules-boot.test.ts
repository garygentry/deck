/**
 * Runtime modules end to end: the real server composition (`boot()`) with DECK_MODULES_DIR
 * pointing at the example module, or at broken ones, and the HTTP listener stubbed.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { UiManifest } from "@deck/module-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stringify } from "yaml";

import { main as cli } from "../src/cli/deck.js";
import { renderConfig } from "../src/cli/render.js";
import { moduleDigest } from "../src/modules/runtime.js";
import { stopScheduler } from "../src/providers/registry.js";
import { boot, type BootHandle } from "../src/server/boot.js";

import { stubBun, unstubBun } from "./util/stub-bun.js";

vi.setConfig({ testTimeout: 30_000 });

const EXAMPLES = fileURLToPath(new URL("../../../examples/modules", import.meta.url));

/** Every line deck's boot logger writes, parsed. */
const logLines: Array<Record<string, unknown>> = [];

vi.mock("../src/log/logger.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/log/logger.js")>();
  const pino = (await import("pino")).default;
  return {
    ...original,
    createLogger: () => pino({ level: "info" }, { write: (line: string) => void logLines.push(JSON.parse(line) as Record<string, unknown>) }),
  };
});

const ENV_NAMES = ["DECK_MODULES_DIR", "DECK_MODULES_ENABLED", "DECK_METRICS_ENABLED"] as const;
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
  logLines.length = 0;
  stopScheduler();
  unstubBun();
  vi.restoreAllMocks();
  for (const name of ENV_NAMES) delete process.env[name];
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const WINDOWS = [
  { name: "kernel upgrades", start: "2000-01-01T00:00:00Z", durationMinutes: 60 },
  { name: "disk swap", start: "2999-01-01T02:00:00Z", durationMinutes: 30 },
];

/** A config directory: a base layer, plus an overlay layer when given. */
function configDir(overlay?: Record<string, unknown>): string {
  const dir = tempDir("deck-rtb-cfg-");
  writeFileSync(join(dir, "00-base.yaml"), stringify({ schemaVersion: 2, estate: { name: "lab" } }));
  if (overlay !== undefined) writeFileSync(join(dir, "10-overlay.yaml"), stringify({ schemaVersion: 2, ...overlay }));
  return dir;
}

function modulesEnv(dir: string, enabled = true): void {
  process.env.DECK_MODULES_DIR = dir;
  if (enabled) process.env.DECK_MODULES_ENABLED = "true";
}

type Request_ = (path: string) => Promise<Response>;

/** Boot deck on `dir` with the HTTP listener stubbed; requests go straight to its fetch handler. */
async function bootOn(dir: string, options: { runtimeImportTimeoutMs?: number } = {}): Promise<Request_> {
  let fetchHandler: ((request: Request) => Response | Promise<Response>) | undefined;
  stubBun({
    serve: (serveOptions: { fetch: (request: Request) => Response | Promise<Response> }) => {
      fetchHandler = serveOptions.fetch;
      return { stop: async () => undefined };
    },
  });
  const handle: BootHandle = await boot({ configDir: dir, port: 0, uiReload: false, ...options });
  cleanup.push(() => handle.stop());
  return (path) => Promise.resolve(fetchHandler!(new Request(`http://deck${path}`)));
}

/** Boot expecting an exit: the code and what was printed. */
async function bootFails(dir: string, options: { runtimeImportTimeoutMs?: number } = {}): Promise<{ code: string; stderr: string }> {
  stubBun({ serve: () => ({ stop: async () => undefined }) });
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  vi.spyOn(process, "exit").mockImplementation(((code: number) => {
    throw new Error(`exit:${code}`);
  }) as never);
  const error = await boot({ configDir: dir, port: 0, uiReload: false, ...options }).then(() => null, (cause: Error) => cause);
  return { code: error?.message ?? "booted", stderr: stderr.mock.calls.map(([text]) => String(text)).join("") };
}

async function json<T>(request: Request_, path: string): Promise<T> {
  const response = await request(path);
  expect(response.status, path).toBe(200);
  return (await response.json()) as T;
}

/**
 * A fresh modules root holding a copy of the maintenance example only (examples/modules also
 * holds the module template's sources, which load only once built).
 */
function exampleRoot(): string {
  const root = tempDir("deck-rtb-mods-");
  cpSync(join(EXAMPLES, "maintenance"), join(root, "maintenance"), { recursive: true });
  return root;
}

/** A broken runtime module directory under a fresh modules root, beside a copy of the example. */
function modulesWithBroken(entry: string): string {
  const root = tempDir("deck-rtb-mods-");
  cpSync(join(EXAMPLES, "maintenance"), join(root, "maintenance"), { recursive: true });
  const dir = join(root, "broken");
  mkdirSync(dir);
  writeFileSync(join(dir, "deck-module.json"), JSON.stringify({
    id: "broken",
    version: "1.0.0",
    deckApi: "^0.1",
    config: { schema: { type: "object", additionalProperties: false, properties: { size: { type: "integer" } } } },
    contributes: { pages: [{ id: "page:broken/main", path: "/broken", title: "Broken", component: "BrokenPage" }] },
  }));
  writeFileSync(join(dir, "server.mjs"), entry);
  return root;
}

describe("a runtime module in DECK_MODULES_DIR", () => {
  it("adds a page, a nav entry, a pill, a provider, routes and health", async () => {
    const root = exampleRoot();
    modulesEnv(root);
    const request = await bootOn(configDir({ modules: { maintenance: { windows: WINDOWS } } }));

    const ui = await json<UiManifest>(request, "/api/ui");
    expect(ui.modules.find((module) => module.id === "maintenance")).toMatchObject({ enabled: true, origin: "module" });
    expect(ui.pages.find((page) => page.id === "page:maintenance/windows")).toMatchObject({ module: "maintenance", path: "/maintenance", title: "Maintenance" });
    expect(ui.nav.find((item) => item.id === "nav:maintenance/windows")).toMatchObject({ group: "operate" });
    expect(ui.extensions.find((extension) => extension.id === "pill:maintenance/next")).toMatchObject({ kind: "pill", slot: "app/topbar.status", order: 60 });
    expect(ui.providers.map((provider) => provider.id)).toContain("maintenance");

    // The provider is polled by the kernel like any other.
    let envelope: { data: { active: { name: string } | null; next: { name: string } | null; count: number } | null } = { data: null };
    await vi.waitFor(async () => {
      envelope = await json(request, "/api/providers/maintenance");
      expect(envelope.data).not.toBeNull();
    });
    expect(envelope.data).toEqual({ active: null, next: { name: "disk swap", start: "2999-01-01T02:00:00Z", end: "2999-01-01T02:30:00.000Z" }, count: 2 });

    expect(await json(request, "/api/m/maintenance/windows")).toEqual({ windows: WINDOWS });
    const health = await json<{ modules: Record<string, unknown> }>(request, "/api/health");
    expect(health.modules.maintenance).toEqual({ state: "ok", detail: "2 window(s)" });
    expect(logLines.find((line) => line.event === "modules.runtime")).toMatchObject({ dir: root, enabled: true, loaded: ["maintenance"], failed: [] });
  });

  it("validates its section with its own schema and config rules: an invalid section fails boot", async () => {
    modulesEnv(exampleRoot());
    const badRule = await bootFails(configDir({ modules: { maintenance: { windows: [{ name: "x", start: "tomorrow", durationMinutes: 5 }] } } }));
    expect(badRule.code).toBe("exit:1");
    expect(badRule.stderr).toContain("MAINTENANCE_START_INVALID");
    expect(badRule.stderr).toContain("/modules/maintenance/windows/0/start");

    const badShape = await bootFails(configDir({ modules: { maintenance: { windows: [{ name: "x" }] } } }));
    expect(badShape.code).toBe("exit:1");
    expect(badShape.stderr).toContain("/modules/maintenance/windows/0");
  });

  it("is off, with its section ignored, while DECK_MODULES_ENABLED is unset", async () => {
    modulesEnv(exampleRoot(), false);
    const request = await bootOn(configDir({ modules: { maintenance: { windows: WINDOWS } } }));
    const ui = await json<UiManifest>(request, "/api/ui");
    expect(ui.modules.find((module) => module.id === "maintenance")).toEqual({
      id: "maintenance",
      version: "1.0.0",
      enabled: false,
      origin: "module",
      reason: "not enabled: DECK_MODULES_ENABLED is not true",
      enabledBy: [{ env: "DECK_MODULES_ENABLED" }],
    });
    // Its page is answered as switched off, not routed.
    expect(ui.pages.map((page) => page.id)).not.toContain("page:maintenance/windows");
    expect(ui.disabledPages?.map((page) => page.id)).toContain("page:maintenance/windows");
    expect((await request("/api/providers/maintenance")).status).toBe(404);
    expect(logLines.find((line) => line.event === "modules.runtime")).toMatchObject({ enabled: false, loaded: [] });
  });

  it("is off, not unknown, without its section", async () => {
    modulesEnv(exampleRoot());
    const request = await bootOn(configDir());
    const ui = await json<UiManifest>(request, "/api/ui");
    expect(ui.modules.find((module) => module.id === "maintenance")).toMatchObject({ enabled: false, enabledBy: [{ config: "modules.maintenance" }] });
  });
});

describe("a runtime module that fails to load", () => {
  it("is disabled with MODULE_LOAD_FAILED while boot continues and the other modules run", async () => {
    modulesEnv(modulesWithBroken(`throw new Error("cannot start: missing native addon");\n`));
    const request = await bootOn(configDir({ modules: { maintenance: { windows: WINDOWS }, broken: { size: 3 } } }));

    const disabled = logLines.find((line) => line.event === "module.disabled" && line.module === "broken");
    expect(disabled).toMatchObject({ code: "MODULE_LOAD_FAILED", level: 40, reason: 'Module "broken" failed to load: import error.' });
    // The log keeps the cause; the API never sees it.
    expect(String(disabled!.detail)).toContain("its server entry failed to import: cannot start: missing native addon");
    expect(logLines.find((line) => line.event === "modules.runtime")).toMatchObject({ loaded: ["maintenance"], failed: ["broken"] });

    const health = await json<{ modules: Record<string, { state: string; detail?: string }> }>(request, "/api/health");
    expect(health.modules.broken).toMatchObject({ state: "disabled" });
    expect(health.modules.broken!.detail).toBe('Module "broken" failed to load: import error.');
    expect(health.modules.maintenance).toMatchObject({ state: "ok" });

    const ui = await json<UiManifest>(request, "/api/ui");
    expect(ui.modules.find((module) => module.id === "broken")).toMatchObject({ enabled: false });
    expect(ui.pages.map((page) => page.id)).not.toContain("page:broken/main");
    expect(ui.pages.map((page) => page.id)).toContain("page:maintenance/windows");
  });

  it("still fails boot when its section is present and invalid", async () => {
    modulesEnv(modulesWithBroken(`throw new Error("boom");\n`));
    const failed = await bootFails(configDir({ modules: { broken: { size: "three" } } }));
    expect(failed.code).toBe("exit:1");
    expect(failed.stderr).toContain("/modules/broken/size");
  });

  it("is disabled when its directory does not match its integrity pin", async () => {
    const root = modulesWithBroken(`import manifest from "./deck-module.json" with { type: "json" };\nexport default { manifest, init() {} };\n`);
    modulesEnv(root);
    const pin = moduleDigest(join(root, "broken"));
    // Pinned and matching: it loads.
    const ok = await bootOn(configDir({ moduleIntegrity: { broken: pin } }));
    expect((await json<UiManifest>(ok, "/api/ui")).pages.map((page) => page.id)).toContain("page:broken/main");
    await cleanup.pop()!();
    stopScheduler();
    logLines.length = 0;

    writeFileSync(join(root, "broken", "extra.mjs"), "export {};\n");
    const request = await bootOn(configDir({ moduleIntegrity: { broken: pin } }));
    const disabled = logLines.find((line) => line.event === "module.disabled" && line.module === "broken");
    expect(disabled).toMatchObject({ code: "MODULE_LOAD_FAILED", reason: 'Module "broken" failed to load: pin mismatch.' });
    expect(String(disabled!.detail)).toContain(`does not match the pinned ${pin}`);
    expect((await json<UiManifest>(request, "/api/ui")).pages.map((page) => page.id)).not.toContain("page:broken/main");
  });

  it("keeps the module's error text and directory out of /api/health and /api/ui", async () => {
    const SENTINEL = "sentinel-7f3a-secret-token";
    const root = modulesWithBroken(`throw new Error("${SENTINEL} at " + import.meta.url);\n`);
    modulesEnv(root);
    const request = await bootOn(configDir());
    for (const path of ["/api/health", "/api/ui"]) {
      const body = await (await request(path)).text();
      expect(body, path).toContain("import error");
      expect(body, path).not.toContain(SENTINEL);
      expect(body, path).not.toContain(root);
    }
    expect(JSON.stringify(logLines)).toContain(SENTINEL);
  });

  it("keeps what its kind handler threw out of /api/health and /api/ui, and in the log", async () => {
    const SENTINEL = "sentinel-91c4-handler-secret";
    const root = tempDir("deck-rtb-mods-");
    const dir = join(root, "feeder");
    mkdirSync(dir);
    writeFileSync(join(dir, "deck-module.json"), JSON.stringify({
      id: "feeder",
      version: "1.0.0",
      deckApi: "^0.1",
      providerKinds: [{ kind: "feeder", instanceSchema: { type: "object" }, statusCapable: false }],
    }));
    writeFileSync(join(dir, "server.mjs"), [
      `import manifest from "./deck-module.json" with { type: "json" };`,
      `export default { manifest, init() {}, kinds: { feeder: { instances() { throw new Error("${SENTINEL} at " + import.meta.url); } } } };`,
      "",
    ].join("\n"));
    modulesEnv(root);
    const request = await bootOn(configDir({ integrations: [{ id: "feed-one", kind: "feeder", title: "Feed" }] }));
    for (const path of ["/api/health", "/api/ui"]) {
      const body = await (await request(path)).text();
      expect(body, path).not.toContain(SENTINEL);
      expect(body, path).not.toContain(root);
    }
    expect(JSON.stringify((await json<{ modules: Record<string, unknown> }>(request, "/api/health")).modules.feeder)).toContain("instances handler threw");
    expect(logLines).toContainEqual(expect.objectContaining({ event: "module.disabled", module: "feeder", code: "MODULE_KIND_HANDLER_FAILED", detail: expect.stringContaining(SENTINEL) }));
  });

  it("stops boot (exit 2) when a server entry never finishes loading, naming the module", async () => {
    modulesEnv(modulesWithBroken(`await new Promise(() => {});\nexport default {};\n`));
    const failed = await bootFails(configDir(), { runtimeImportTimeoutMs: 200 });
    expect(failed.code).toBe("exit:2");
    expect(failed.stderr).toContain('runtime module "broken": its server entry did not finish loading within 200 ms');
  });

  it("checks a failed module's section as if it ran: layer ownership and overlay references too", async () => {
    const root = tempDir("deck-rtb-mods-");
    mkdirSync(join(root, "ref"));
    writeFileSync(join(root, "ref", "deck-module.json"), JSON.stringify({
      id: "ref",
      version: "1.0.0",
      deckApi: "^0.1",
      config: {
        schema: { type: "object", properties: { target: { type: "object" }, note: { type: "string" } } },
        ownership: { "": "overlay" },
        references: ["target"],
      },
    }));
    writeFileSync(join(root, "ref", "server.mjs"), `throw new Error("broken");\n`);
    modulesEnv(root);
    // In the base layer, the overlay-owned section is a layer problem, as it would be if the module ran.
    const base = tempDir("deck-rtb-cfg-");
    writeFileSync(join(base, "00-base.yaml"), stringify({ schemaVersion: 2, estate: { name: "lab" }, modules: { ref: { note: "x" } } }));
    const layered = await bootFails(base);
    expect(layered.code).toBe("exit:1");
    expect(layered.stderr).toContain("LAYER_OVERLAY_KEY_IN_BASE");
    // An overlay reference to a host the base does not declare dangles.
    const dangling = await bootFails(configDir({ modules: { ref: { target: { host: "ghost" } } } }));
    expect(dangling.code).toBe("exit:1");
    expect(dangling.stderr).toContain("OVERLAY_DANGLING_REF");

    // Switched off, the same section is advisory.
    delete process.env.DECK_MODULES_ENABLED;
    await bootOn(base);
  });

  it("rejects a malformed pin in config", async () => {
    modulesEnv(exampleRoot());
    const failed = await bootFails(configDir({ moduleIntegrity: { maintenance: "sha1-nope" } }));
    expect(failed.code).toBe("exit:1");
    expect(failed.stderr).toContain("/moduleIntegrity/maintenance");
  });

  it("fails boot (exit 2) when runtime modules are on and DECK_MODULES_DIR cannot be read", async () => {
    modulesEnv(join(tempDir("deck-rtb-"), "absent"));
    const failed = await bootFails(configDir());
    expect(failed.code).toBe("exit:2");
    expect(failed.stderr).toContain("DECK_MODULES_DIR");
  });
});

describe("runtime modules that collide with built-ins", () => {
  function collidingRoot(): string {
    const root = tempDir("deck-rtb-mods-");
    mkdirSync(join(root, "portal")); // empty, named like a built-in
    for (const [id, extra] of [
      ["legacy-key", { health: { legacyKey: "llmUsage" } }],
      ["kind-thief", { providerKinds: [{ kind: "prometheus" }] }],
    ] as const) {
      mkdirSync(join(root, id));
      writeFileSync(join(root, id, "deck-module.json"), JSON.stringify({ id, version: "1.0.0", deckApi: "^0.1", ...extra }));
    }
    return root;
  }

  for (const enabled of [true, false]) {
    it(`never abort boot (DECK_MODULES_ENABLED ${enabled ? "on" : "off"})`, async () => {
      modulesEnv(collidingRoot(), enabled);
      const request = await bootOn(configDir());
      const health = await json<{ modules: Record<string, { state: string; detail?: string }> }>(request, "/api/health");
      // The built-in portal is untouched.
      expect(health.modules.portal).toMatchObject({ state: "ok" });
      const ui = await json<UiManifest>(request, "/api/ui");
      for (const id of ["legacy-key", "kind-thief"]) {
        const module = ui.modules.find((candidate) => candidate.id === id)!;
        expect(module.enabled).toBe(false);
        expect(module.reason).toBe(enabled ? `Module "${id}" failed to load: collision.` : "not enabled: DECK_MODULES_ENABLED is not true");
      }
      const event = logLines.find((line) => line.event === "modules.runtime");
      expect(event).toMatchObject({ level: 40, rejected: [{ id: "portal" }] });
    });
  }
});

describe("round 2: failed and inert modules claim nothing", () => {
  /** A module directory with a manifest and, unless null, a server entry. */
  function writeRuntime(root: string, id: string, manifest: Record<string, unknown> | string, entry: string | null = null): void {
    mkdirSync(join(root, id));
    writeFileSync(join(root, id, "deck-module.json"), typeof manifest === "string" ? manifest : JSON.stringify({ id, version: "1.0.0", deckApi: "^0.1", ...manifest }));
    if (entry !== null) writeFileSync(join(root, id, "server.mjs"), entry);
  }

  it("a colliding module's present, invalid section still fails boot", async () => {
    const root = tempDir("deck-rtb-mods-");
    writeRuntime(root, "thief", { providerKinds: [{ kind: "prometheus" }], config: { schema: { type: "object", additionalProperties: false, properties: { size: { type: "integer" } } } } });
    modulesEnv(root);
    const failed = await bootFails(configDir({ modules: { thief: { size: "big" } } }));
    expect(failed.code).toBe("exit:1");
    expect(failed.stderr).toContain("/modules/thief/size");
  });

  it("a module whose manifest is unknown leaves its section exempt: a base-layer section does not stop boot", async () => {
    const root = tempDir("deck-rtb-mods-");
    writeRuntime(root, "garbled", "{ not json");
    modulesEnv(root);
    const base = tempDir("deck-rtb-cfg-");
    writeFileSync(join(base, "00-base.yaml"), stringify({ schemaVersion: 2, estate: { name: "lab" }, modules: { garbled: { anything: 1 } } }));
    const request = await bootOn(base);
    expect((await json<UiManifest>(request, "/api/ui")).modules.find((module) => module.id === "garbled")).toMatchObject({ enabled: false, reason: 'Module "garbled" failed to load: bad manifest.' });
  });

  it("an inert module's dependency and service edges never reach an active module", async () => {
    const root = tempDir("deck-rtb-mods-");
    writeRuntime(root, "cycle", { dependsOn: ["metrics"], services: { provides: ["snapshot/content"] } });
    modulesEnv(root, false);
    process.env.DECK_METRICS_ENABLED = "true";
    const request = await bootOn(configDir());
    const ui = await json<UiManifest>(request, "/api/ui");
    expect(ui.modules.find((module) => module.id === "metrics")).toMatchObject({ enabled: true });
    expect(ui.modules.find((module) => module.id === "cycle")).toMatchObject({ enabled: false, reason: "not enabled: DECK_MODULES_ENABLED is not true", enabledBy: [{ env: "DECK_MODULES_ENABLED" }] });
  });

  it("uses an overlay's fresh pin over a stale base pin for the same module", async () => {
    const root = tempDir("deck-rtb-mods-");
    cpSync(join(EXAMPLES, "maintenance"), join(root, "maintenance"), { recursive: true });
    modulesEnv(root);
    const dir = tempDir("deck-rtb-cfg-");
    writeFileSync(join(dir, "00-base.yaml"), stringify({ schemaVersion: 2, estate: { name: "lab" }, moduleIntegrity: { maintenance: `sha256-${"A".repeat(43)}=` } }));
    writeFileSync(join(dir, "10-overlay.yaml"), stringify({ schemaVersion: 2, moduleIntegrity: { maintenance: moduleDigest(join(root, "maintenance")) }, modules: { maintenance: { windows: WINDOWS } } }));
    const request = await bootOn(dir);
    expect((await json<UiManifest>(request, "/api/ui")).modules.find((module) => module.id === "maintenance")).toMatchObject({ enabled: true });
  });

  it("boot, validate and render fail the same modules (a dependant of a failed one is never loaded)", async () => {
    const root = tempDir("deck-rtb-mods-");
    const entry = `import manifest from "./deck-module.json" with { type: "json" };\nexport default { manifest, init() {} };\n`;
    writeRuntime(root, "aaa", {}, entry);
    writeRuntime(root, "bbb", { dependsOn: ["aaa"], config: { schema: { type: "object", properties: { size: { type: "integer" } } } } }, entry);
    modulesEnv(root);
    const stale = `sha256-${"A".repeat(43)}=`;
    const config = configDir({ moduleIntegrity: { aaa: stale, bbb: stale }, modules: { bbb: { size: "big" } } });
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    // Boot goes on: aaa fails to load, bbb is off for its dependency, so its section is advisory.
    const request = await bootOn(config);
    const reasons = Object.fromEntries((await json<UiManifest>(request, "/api/ui")).modules.filter((module) => ["aaa", "bbb"].includes(module.id)).map((module) => [module.id, module.reason]));
    expect(reasons).toEqual({ aaa: 'Module "aaa" failed to load: pin mismatch.', bbb: 'Module "bbb" depends on "aaa", which is not available.' });
    expect(logLines.find((line) => line.event === "module.disabled" && line.module === "bbb")).toMatchObject({ code: "MODULE_DEPENDENCY_MISSING" });

    // Render loads as boot does.
    expect(cli(["render", config, "--out", join(tempDir("deck-rtb-out-"), "out.json")])).toBe(0);
    // Validate reports the same load failure (aaa only) as a warning, so it exits 1.
    stderr.mockClear();
    expect(cli(["validate", config])).toBe(1);
    const printed = stderr.mock.calls.map(([text]) => String(text)).join("");
    expect(printed).toContain('Module "aaa" failed to load: pin mismatch.');
    expect(printed).not.toContain('Module "bbb" failed to load');
  });
});

describe("the deck CLI with DECK_MODULES_DIR", () => {
  it("validates a runtime module's section from its manifest, running none of its code", () => {
    modulesEnv(exampleRoot());
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(cli(["validate", configDir({ modules: { maintenance: { windows: WINDOWS } } })])).toBe(0);
    expect(cli(["validate", configDir({ modules: { maintenance: { windows: [{ name: "x" }] } } })])).toBe(1);
    const printed = stderr.mock.calls.map(([text]) => String(text)).join("");
    expect(printed).toContain("/modules/maintenance/windows/0");
    expect(printed).not.toContain("MODULE_UNKNOWN");
    expect(stdout).toHaveBeenCalled();
  });

  it("validates a running runtime module's provider-kind instances as known, not as a switched-off module's", () => {
    const root = tempDir("deck-rtb-mods-");
    mkdirSync(join(root, "feed"));
    writeFileSync(join(root, "feed", "deck-module.json"), JSON.stringify({
      id: "feed",
      version: "1.0.0",
      deckApi: "^0.1",
      providerKinds: [{ kind: "feed", instanceSchema: { type: "object", required: ["id", "kind", "url"], properties: { id: { type: "string" }, kind: { const: "feed" }, url: { type: "string" } } } }],
    }));
    writeFileSync(join(root, "feed", "server.mjs"), `throw new Error("validate must not import me");\n`);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const config = configDir({ integrations: [{ id: "news", kind: "feed", url: "https://example.test/feed" }] });

    modulesEnv(root);
    expect(cli(["validate", config])).toBe(0);
    // An instance that breaks the kind's schema is an error, as it would be at boot.
    expect(cli(["validate", configDir({ integrations: [{ id: "news", kind: "feed" }] })])).toBe(1);
    expect(stderr.mock.calls.map(([text]) => String(text)).join("")).toContain("/integrations/0");

    // Switched off, the kind is a switched-off module's, as for any module: its instance is
    // not checked against the kind's schema, so it fails as an unknown integration.
    stderr.mockClear();
    delete process.env.DECK_MODULES_ENABLED;
    expect(cli(["validate", config])).toBe(1);
    expect(stderr.mock.calls.map(([text]) => String(text)).join("")).toContain("/integrations/0/url  SCHEMA_UNKNOWN_PROPERTY");
  });

  it("plans a bindable runtime kind as boot does: validate, render and boot agree", async () => {
    const root = tempDir("deck-rtb-mods-");
    mkdirSync(join(root, "probe"));
    writeFileSync(join(root, "probe", "deck-module.json"), JSON.stringify({ id: "probe", version: "1.0.0", deckApi: "^0.1", providerKinds: [{ kind: "probe", bindable: true }] }));
    writeFileSync(join(root, "probe", "server.mjs"), `import manifest from "./deck-module.json" with { type: "json" };\nexport default { manifest, init() {}, kinds: { probe: { binding: () => [] } } };\n`);
    const config = tempDir("deck-rtb-cfg-");
    writeFileSync(join(config, "00-base.yaml"), stringify({ schemaVersion: 2, estate: { name: "lab" }, hosts: [{ name: "h1", kind: "vm", purpose: "test" }] }));
    writeFileSync(join(config, "10-overlay.yaml"), stringify({ schemaVersion: 2, hosts: [{ name: "h1", bindings: { probe: { target: "x" } } }] }));
    modulesEnv(root);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(cli(["validate", config])).toBe(0);
    expect(() => renderConfig(config)).not.toThrow();
    const request = await bootOn(config);
    expect((await json<UiManifest>(request, "/api/ui")).modules.find((module) => module.id === "probe")).toMatchObject({ enabled: true });
    expect(stderr.mock.calls.map(([text]) => String(text)).join("")).not.toContain("PROVIDER_KIND");
  });

  it("reports a runtime module whose directory does not match its pin, as boot would refuse it", () => {
    const root = tempDir("deck-rtb-mods-");
    cpSync(join(EXAMPLES, "maintenance"), join(root, "maintenance"), { recursive: true });
    modulesEnv(root);
    const pinned = (pin: string) => configDir({ moduleIntegrity: { maintenance: pin }, modules: { maintenance: { windows: WINDOWS } } });
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(cli(["validate", pinned(moduleDigest(join(root, "maintenance")))])).toBe(0);
    const stale = pinned(`sha256-${"A".repeat(43)}=`);
    expect(cli(["validate", stale])).toBe(1);
    const printed = stderr.mock.calls.map(([text]) => String(text)).join("");
    expect(printed).toContain("MODULE_LOAD_FAILED");
    expect(printed).toContain('Module "maintenance" failed to load: pin mismatch.');
    // Boot goes on without the module, and so does render.
    expect(cli(["render", stale, "--out", join(tempDir("deck-rtb-out-"), "out.json")])).toBe(0);
  });

  it("render reports an unreadable DECK_MODULES_DIR as a tool error, exit 2", () => {
    modulesEnv(join(tempDir("deck-rtb-"), "absent"));
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const config = configDir();
    expect(cli(["render", config, "--out", join(tempDir("deck-rtb-out-"), "out.json")])).toBe(2);
    expect(String(stderr.mock.calls[0]![0])).toContain("MODULES_DIR_UNREADABLE");
    expect(() => renderConfig(config)).toThrow("MODULES_DIR_UNREADABLE");
    expect(cli(["validate", config])).toBe(2);
  });

  it("prints a module directory's integrity pin", () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    expect(cli(["module", "digest", join(EXAMPLES, "maintenance")])).toBe(0);
    expect(String(stdout.mock.calls[0]![0])).toBe(`${moduleDigest(join(EXAMPLES, "maintenance"))}\n`);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(cli(["module", "digest", join(EXAMPLES, "absent")])).toBe(2);
    expect(String(stderr.mock.calls[0]![0])).toContain("MODULE_DIGEST_FAILED");
  });
});
