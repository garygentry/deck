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
import { moduleDigest } from "../src/modules/runtime.js";
import { stopScheduler } from "../src/providers/registry.js";
import { boot, type BootHandle } from "../src/server/boot.js";

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

const ENV_NAMES = ["DECK_MODULES_DIR", "DECK_MODULES_ENABLED"] as const;
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
  logLines.length = 0;
  stopScheduler();
  vi.unstubAllGlobals();
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
async function bootOn(dir: string): Promise<Request_> {
  let fetchHandler: ((request: Request) => Response | Promise<Response>) | undefined;
  vi.stubGlobal("Bun", {
    serve: (serveOptions: { fetch: (request: Request) => Response | Promise<Response> }) => {
      fetchHandler = serveOptions.fetch;
      return { stop: async () => undefined };
    },
  });
  const handle: BootHandle = await boot({ configDir: dir, port: 0, uiReload: false });
  cleanup.push(() => handle.stop());
  return (path) => Promise.resolve(fetchHandler!(new Request(`http://deck${path}`)));
}

/** Boot expecting an exit: the code and what was printed. */
async function bootFails(dir: string): Promise<{ code: string; stderr: string }> {
  vi.stubGlobal("Bun", { serve: () => ({ stop: async () => undefined }) });
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  vi.spyOn(process, "exit").mockImplementation(((code: number) => {
    throw new Error(`exit:${code}`);
  }) as never);
  const error = await boot({ configDir: dir, port: 0, uiReload: false }).then(() => null, (cause: Error) => cause);
  return { code: error?.message ?? "booted", stderr: stderr.mock.calls.map(([text]) => String(text)).join("") };
}

async function json<T>(request: Request_, path: string): Promise<T> {
  const response = await request(path);
  expect(response.status, path).toBe(200);
  return (await response.json()) as T;
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
    modulesEnv(EXAMPLES);
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
    expect(logLines.find((line) => line.event === "modules.runtime")).toMatchObject({ dir: EXAMPLES, enabled: true, loaded: ["maintenance"], failed: [] });
  });

  it("validates its section with its own schema and config rules: an invalid section fails boot", async () => {
    modulesEnv(EXAMPLES);
    const badRule = await bootFails(configDir({ modules: { maintenance: { windows: [{ name: "x", start: "tomorrow", durationMinutes: 5 }] } } }));
    expect(badRule.code).toBe("exit:1");
    expect(badRule.stderr).toContain("MAINTENANCE_START_INVALID");
    expect(badRule.stderr).toContain("/modules/maintenance/windows/0/start");

    const badShape = await bootFails(configDir({ modules: { maintenance: { windows: [{ name: "x" }] } } }));
    expect(badShape.code).toBe("exit:1");
    expect(badShape.stderr).toContain("/modules/maintenance/windows/0");
  });

  it("is off, with its section ignored, while DECK_MODULES_ENABLED is unset", async () => {
    modulesEnv(EXAMPLES, false);
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
    modulesEnv(EXAMPLES);
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
    expect(disabled).toMatchObject({ code: "MODULE_LOAD_FAILED", level: 40 });
    expect(String(disabled!.reason)).toContain("its server entry failed to import: cannot start: missing native addon");
    expect(logLines.find((line) => line.event === "modules.runtime")).toMatchObject({ loaded: ["maintenance"], failed: ["broken"] });

    const health = await json<{ modules: Record<string, { state: string; detail?: string }> }>(request, "/api/health");
    expect(health.modules.broken).toMatchObject({ state: "disabled" });
    expect(health.modules.broken!.detail).toContain('Module "broken" failed to load');
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
    expect(disabled).toMatchObject({ code: "MODULE_LOAD_FAILED" });
    expect(String(disabled!.reason)).toContain(`does not match the pinned ${pin}`);
    expect((await json<UiManifest>(request, "/api/ui")).pages.map((page) => page.id)).not.toContain("page:broken/main");
  });

  it("rejects a malformed pin in config", async () => {
    modulesEnv(EXAMPLES);
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

describe("the deck CLI with DECK_MODULES_DIR", () => {
  it("validates a runtime module's section from its manifest, running none of its code", () => {
    modulesEnv(EXAMPLES);
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

  it("prints a module directory's integrity pin", () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    expect(cli(["module", "digest", join(EXAMPLES, "maintenance")])).toBe(0);
    expect(String(stdout.mock.calls[0]![0])).toBe(`${moduleDigest(join(EXAMPLES, "maintenance"))}\n`);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(cli(["module", "digest", join(EXAMPLES, "absent")])).toBe(2);
    expect(String(stderr.mock.calls[0]![0])).toContain("MODULE_DIGEST_FAILED");
  });
});
