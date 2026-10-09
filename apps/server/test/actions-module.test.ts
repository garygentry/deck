/**
 * The actions module through the module host: switched on only by DECK_ACTIONS_ENABLED,
 * the switched-off answers it declares (byte-identical to the routes' own disabled
 * answers), its legacy alias, its shutdown hook, and the isolation of its capabilities.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { ACTIONS_UI } from "@deck/contract/modules/actions";
import { defineServerModule, type ServerModuleContext } from "@deck/module-sdk";
import { composeDefault } from "@deck/schema";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as actionsModuleExports from "../../../modules/actions/server/module.js";
import { ACTIONS_MANIFEST, actionsModule, createActionsModule } from "../../../modules/actions/server/module.js";
import { BUILTIN_MODULES } from "../src/modules/builtin.js";
import { ModuleInitError } from "../src/modules/host.js";
import { ACTIONS_FIXTURES_DIR, actionsApp } from "./util/actions-module.js";
import { createFakeSpawner, type FakeSpawner } from "./util/fake-spawner.js";
import { testHost } from "./util/modules.js";
import { serverOnlyFields } from "./util/shared-ui.js";
import { makeDataDir } from "./util/tmp-data.js";

const RUNNERS_FILE = join(ACTIONS_FIXTURES_DIR, "runners.json");
const enc = (text: string) => new TextEncoder().encode(text);

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

function dataDir(): string {
  const { dir, cleanup } = makeDataDir();
  cleanups.push(cleanup);
  return dir;
}

function enabledEnv(dir: string, extra: Record<string, string> = {}): Record<string, string> {
  return { DECK_ACTIONS_ENABLED: "true", DECK_DATA_DIR: dir, DECK_RUNNERS_FILE: RUNNERS_FILE, ...extra };
}

async function enabledApp(spawner: FakeSpawner, options: { stopTimeoutMs?: number } = {}) {
  const dir = dataDir();
  const fixture = await actionsApp({ env: enabledEnv(dir), createSpawner: () => spawner, ...options });
  cleanups.push(() => fixture.host.stop());
  return { ...fixture, dir };
}

async function answer(app: { request: Hono["request"] }, method: string, path: string, body?: string) {
  const response = await app.request(path, { method, ...(body === undefined ? {} : { body, headers: { "content-type": "application/json" } }) });
  return { status: response.status, contentType: response.headers.get("content-type"), body: await response.text() };
}

interface GoldenProjection { status: number; contentType: string; body: unknown }

/** The frozen pre-module answers of a deck with the capability off (parity golden, byte-frozen). */
function frozenOffAnswers() {
  const golden = JSON.parse(readFileSync(fileURLToPath(new URL("./golden/parity/schema-primary.json", import.meta.url)), "utf8")) as {
    actions: GoldenProjection;
    actionRefusals: Record<string, GoldenProjection>;
    actionsAudit: GoldenProjection;
  };
  const wire = ({ status, contentType, body }: GoldenProjection) => ({ status, contentType, body: JSON.stringify(body) });
  const refusal = wire(golden.actionRefusals.unknownAction!);
  return { probe: wire(golden.actions), refusal, audit: wire(golden.actionsAudit) };
}

describe("actions module manifest", () => {
  it("is a built-in module switched on by DECK_ACTIONS_ENABLED, owning modules.actions and the /api/actions alias", () => {
    expect(BUILTIN_MODULES).toContain(actionsModule);
    expect(ACTIONS_MANIFEST).toMatchObject({
      id: "actions",
      enabledBy: { env: "DECK_ACTIONS_ENABLED" },
      config: { ownership: { "": "overlay" }, references: ["actions[].target"] },
      contributes: { routes: { legacyAliases: ["/api/actions"] } },
    });
    expect(ACTIONS_MANIFEST.env).toEqual(["DECK_ACTIONS_ENABLED", "DECK_ACTION_TIMEOUT_MS", "DECK_RUNNERS_FILE"]);
    expect(ACTIONS_MANIFEST.dataDir).toEqual({ legacyPath: "actions" });
  });

  it("takes its identity and UI contributions from the copy the web half registers against", () => {
    const { id, version, deckApi, contributes = {} } = ACTIONS_MANIFEST;
    const { routes, ...ui } = contributes;
    expect({ id, version, deckApi, contributes: ui }).toEqual(ACTIONS_UI);
    expect(contributes.pages).toBe(ACTIONS_UI.contributes?.pages);
    expect(contributes.nav).toBe(ACTIONS_UI.contributes?.nav);
    expect(serverOnlyFields(ACTIONS_UI)).toEqual([]);
    // Only the routes are the server's own: their disabled refusals carry its error codes.
    expect(routes?.legacyAliases).toEqual(["/api/actions"]);
  });

  it.each([
    ["true", true], ["TRUE", true], ["1", true], [" True ", true],
    ["false", false], ["0", false], ["yes", false], ["", false], [undefined, false],
  ])("DECK_ACTIONS_ENABLED=%j runs the module: %s (true or 1, any case, as before)", (value, enabled) => {
    const env = value === undefined ? {} : { DECK_ACTIONS_ENABLED: value };
    const { host } = testHost([actionsModule], { env });
    expect(host.plan).toEqual([enabled
      ? { id: "actions", enabled: true }
      : { id: "actions", enabled: false, reason: "not enabled: DECK_ACTIONS_ENABLED is not true", gates: [{ env: "DECK_ACTIONS_ENABLED" }] }]);
  });
});

describe("actions module switched off", () => {
  it("answers every route with the frozen pre-module bytes, at /api/actions and /api/m/actions", async () => {
    const off = frozenOffAnswers();
    const notFound = { status: 404, contentType: "application/json", body: '{"error":"Not found","code":"NOT_FOUND"}' };
    const probes: ReadonlyArray<[method: string, path: string, expected: ReturnType<typeof answer> extends Promise<infer A> ? A : never, body?: string]> = [
      ["GET", "", off.probe],
      ["POST", "/restart-quiet", off.refusal, "{}"],
      ["POST", "/deploy", off.refusal, '{"count":"many"}'],
      ["POST", "/runs/some-run/cancel", off.refusal],
      ["GET", "/audit", off.audit],
      ["GET", "/audit/some-run", off.refusal],
      ["GET", "/unknown", notFound],
      ["POST", "/runs/some-run", notFound],
    ];
    expect(off.probe.body).toBe('{"enabled":false}');
    expect(off.refusal).toEqual({ status: 403, contentType: "application/json", body: '{"error":"The actions capability is disabled on this deck instance.","code":"ACTIONS_DISABLED"}' });

    const { app, host } = await actionsApp();
    expect(host.plan[0]).toMatchObject({ id: "actions", enabled: false });
    for (const [method, path, expected, body] of probes) {
      for (const prefix of ["/api/actions", "/api/m/actions"]) {
        expect(await answer(app, method, `${prefix}${path}`, body), `${method} ${prefix}${path}`).toEqual(expected);
      }
    }
  });

  it("runs no module code and touches no data dir", async () => {
    const createSpawner = vi.fn(() => createFakeSpawner({}));
    const dir = dataDir();
    await actionsApp({ createSpawner, env: { DECK_DATA_DIR: dir, DECK_RUNNERS_FILE: "/nonexistent/runners.json" } });
    expect(createSpawner).not.toHaveBeenCalled();
    expect(existsSync(join(dir, "actions"))).toBe(false);
  });

  it("reports its state in /api/health.modules", async () => {
    const { app } = await actionsApp();
    const health = (await (await app.request("/api/health")).json()) as { modules: Record<string, unknown> };
    expect(health.modules.actions).toEqual({ state: "disabled", detail: "not enabled: DECK_ACTIONS_ENABLED is not true" });
  });
});

describe("actions module switched on", () => {
  it("serves the same bodies at /api/m/actions and the legacy /api/actions, auditing to DECK_DATA_DIR/actions", async () => {
    const spawner = createFakeSpawner({ stdout: [enc("ok\n")], exitCode: 0 });
    const { app, dir } = await enabledApp(spawner);
    expect(await (await app.request("/api/actions")).json()).toEqual({ enabled: true });
    expect(await (await app.request("/api/m/actions")).json()).toEqual({ enabled: true });

    for (const prefix of ["/api/actions", "/api/m/actions"]) {
      const run = await app.request(`${prefix}/restart-quiet`, { method: "POST", body: "{}" });
      expect(run.status).toBe(200);
      expect(await run.text()).toContain('"outcome":"succeeded"');
    }
    const legacy = await (await app.request("/api/actions/audit")).text();
    expect(await (await app.request("/api/m/actions/audit")).text()).toBe(legacy);
    expect(JSON.parse(legacy)).toHaveLength(2);
    expect(readFileSync(join(dir, "actions/audit.jsonl"), "utf8").trim().split("\n")).toHaveLength(2);
    expect(spawner.calls.map((call) => call.executable)).toEqual(["/usr/bin/true", "/usr/bin/true"]);
  });

  it("refuses an undeclared action with 404 and audits the refusal", async () => {
    const { app } = await enabledApp(createFakeSpawner({}));
    const refused = await app.request("/api/actions/not-declared", { method: "POST", body: "{}" });
    expect(refused.status).toBe(404);
    expect(await refused.json()).toEqual({ error: "No action is declared with id 'not-declared'.", code: "ACTION_UNKNOWN" });
    expect(await (await app.request("/api/actions/audit")).json()).toEqual([expect.objectContaining({ actionId: "not-declared", outcome: "rejected" })]);
  });

  it.each([
    [{ DECK_DATA_DIR: "" }, 'module "actions" called dataDir(): DECK_DATA_DIR is required for module data.'],
    [{ DECK_DATA_DIR: "relative/data" }, 'module "actions" called dataDir(): DECK_DATA_DIR must be absolute; got "relative/data".'],
    [{ DECK_RUNNERS_FILE: "" }, "DECK_RUNNERS_FILE is required when DECK_ACTIONS_ENABLED is true."],
    [{ DECK_ACTION_TIMEOUT_MS: "soon" }, 'DECK_ACTION_TIMEOUT_MS must be a positive integer (ms); got "soon".'],
  ])("fails init (boot exits 2) on a half-configured write path: %j", async (override, message) => {
    const { host } = testHost([actionsModule], { env: enabledEnv(dataDir(), override) });
    const failure = await host.start().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ModuleInitError);
    expect((failure as Error).message).toBe(`module "actions" failed to initialise: ${message}`);
  });

  it("cancels in-flight runs as soon as shutdown begins, before later-stopping modules finish, and audits them", async () => {
    const spawner = createFakeSpawner({ stdout: [enc("working\n")], hang: true });
    const dir = dataDir();
    const auditIndex = join(dir, "actions/audit.jsonl");
    let cancelledBeforeSlowHookEnded: boolean | undefined;
    // Initialised after actions, so the ordered stop reaches it first; its hook is slow.
    const slow = defineServerModule({ id: "slow", version: "1.0.0", deckApi: "^0.1", dependsOn: ["actions"] }, (ctx) => {
      ctx.onStop(async () => {
        await new Promise((resolve) => setTimeout(resolve, 300));
        cancelledBeforeSlowHookEnded = existsSync(auditIndex) && readFileSync(auditIndex, "utf8").includes('"outcome":"cancelled"');
      });
    });
    const actions = createActionsModule({ createSpawner: () => spawner });
    const { host } = testHost([actions, slow], { env: enabledEnv(dir), sectionOf: (id) => (id === "actions" ? { actions: [{ id: "hold", title: "Hold", runner: "echo-runner", confirm: "none" }] } : undefined) });
    await host.start();
    const app = new Hono();
    host.mount(app);

    const run = await app.request("/api/actions/hold", { method: "POST", body: "{}" });
    const reader = run.body!.getReader();
    let stream = new TextDecoder().decode((await reader.read()).value);
    while (!stream.includes("working")) stream += new TextDecoder().decode((await reader.read()).value);

    await host.stop();
    expect(cancelledBeforeSlowHookEnded).toBe(true);
    for (;;) {
      const step = await reader.read();
      if (step.done) break;
      stream += new TextDecoder().decode(step.value);
    }
    expect(stream).toContain('"outcome":"cancelled"');
    expect(spawner.calls[0]!.handle!.killSignals[0]).toBe("SIGTERM");
  });

  it("bounds the cancel at its own stop timeout: a run that will not die is abandoned and logged", async () => {
    const spawner = createFakeSpawner({ stdout: [enc("working\n")], hang: true, ignoreTerm: true, holdStreams: true });
    const actions = createActionsModule({ createSpawner: () => spawner, stopTimeoutMs: 100 });
    const config = { schemaVersion: 2, estate: { name: "x" }, modules: { actions: { actions: [{ id: "hold", title: "Hold", runner: "echo-runner", confirm: "none" }] } } };
    const { host, lines } = testHost([actions], { env: enabledEnv(dataDir()), sectionOf: (id) => (config.modules as Record<string, unknown>)[id] });
    await host.start();
    const app = new Hono();
    host.mount(app);
    const run = await app.request("/api/actions/hold", { method: "POST", body: "{}" });
    const reader = run.body!.getReader();
    await reader.read();

    const startedAt = Date.now();
    await host.stop();
    expect(Date.now() - startedAt).toBeLessThan(900);
    expect(lines).toContainEqual(expect.objectContaining({ event: "actions.stop-hook-timeout", hookTimeoutMs: 100, module: "actions" }));
    void reader.cancel().catch(() => {});
    spawner.calls[0]!.handle!.releaseHang();
  });
});

describe("actions capabilities stay inside the module", () => {
  /**
   * Every object reachable by property access from `roots` (functions included as values;
   * a closure's captured variables are not reachable, which is the point).
   */
  function reachable(roots: unknown[]): Set<object> {
    const seen = new Set<object>();
    const queue = [...roots];
    while (queue.length > 0) {
      const value = queue.pop();
      if ((typeof value !== "object" && typeof value !== "function") || value === null || seen.has(value)) continue;
      seen.add(value);
      if (value instanceof Map) for (const [key, entry] of value) queue.push(key, entry);
      if (value instanceof Set) for (const entry of value) queue.push(entry);
      for (const key of Reflect.ownKeys(value)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (descriptor && "value" in descriptor) queue.push(descriptor.value);
      }
    }
    return seen;
  }

  const isExecutor = (value: object) => ["start", "cancel", "cancelAll"].every((key) => typeof (value as Record<string, unknown>)[key] === "function");
  const isAuditStore = (value: object) => ["append", "list", "read"].every((key) => typeof (value as Record<string, unknown>)[key] === "function");
  const isRunnerAllowlist = (value: object) => value instanceof Map && value.has("echo-runner");

  it("no other module can obtain the runner allowlist, the executor or the audit store", async () => {
    const spawner = createFakeSpawner({ stdout: [enc("ok\n")], exitCode: 0 });
    const contexts: ServerModuleContext<unknown>[] = [];
    // Initialised after actions, it gets everything a module can get, and asks for more
    // through config pointers.
    const probe = defineServerModule({
      id: "probe",
      version: "1.0.0",
      deckApi: "^0.1",
      dependsOn: ["actions"],
      envFromConfig: ["/runners", "/data", "/timeout"],
    }, (ctx) => {
      contexts.push(ctx);
    });
    // Others declare the settings outright; they sort before "actions", which still wins.
    const thiefInit = vi.fn();
    const runnersThief = defineServerModule({ id: "aaa-runners", version: "1.0.0", deckApi: "^0.1", env: ["DECK_RUNNERS_FILE"] }, thiefInit);
    const dataThief = defineServerModule({ id: "aaa-data", version: "1.0.0", deckApi: "^0.1", env: ["DECK_DATA_DIR"] }, thiefInit);
    const actions = createActionsModule({ createSpawner: () => spawner });
    const dir = dataDir();
    const sections: Record<string, unknown> = {
      probe: { runners: "DECK_RUNNERS_FILE", data: "DECK_DATA_DIR", timeout: "DECK_ACTION_TIMEOUT_MS" },
      actions: { actions: [{ id: "restart-quiet", title: "Restart quietly", runner: "echo-runner", confirm: "none" }] },
    };
    const { host } = testHost([runnersThief, dataThief, actions, probe], {
      env: enabledEnv(dir, { DECK_ACTION_TIMEOUT_MS: "5000" }),
      sectionOf: (id) => sections[id],
      builtins: new Set([actions]),
    });
    expect(host.findings).toEqual([
      expect.objectContaining({ code: "MODULE_MANIFEST_INVALID", path: "/modules/aaa-data", message: 'Module "aaa-data" has an invalid manifest: env name "DECK_DATA_DIR" is a deployment setting the kernel reads.' }),
      expect.objectContaining({ code: "MODULE_MANIFEST_INVALID", path: "/modules/aaa-runners", message: 'Module "aaa-runners" has an invalid manifest: env name "DECK_RUNNERS_FILE" is owned by module "actions".' }),
    ]);
    await host.start();
    expect(thiefInit).not.toHaveBeenCalled();
    expect(host.plan.filter((entry) => entry.enabled).map((entry) => entry.id)).toEqual(["actions", "probe"]);

    // A real run: the executor and audit store are live, not just constructed.
    const app = new Hono();
    host.mount(app);
    const run = await app.request("/api/actions/restart-quiet", { method: "POST", body: "{}" });
    expect(run.status).toBe(200);
    expect(await run.text()).toContain('"outcome":"succeeded"');
    expect(spawner.calls).toHaveLength(1);
    await vi.waitFor(async () => expect(await (await app.request("/api/actions/audit")).json()).toHaveLength(1));

    const [ctx] = contexts;
    // Neither a kernel setting nor one the actions module owns opens through a config pointer.
    expect(ctx!.env.get("DECK_RUNNERS_FILE")).toBeUndefined();
    expect(ctx!.env.get("DECK_DATA_DIR")).toBeUndefined();
    expect(ctx!.env.get("DECK_ACTION_TIMEOUT_MS")).toBeUndefined();

    const exposed = reachable([ctx, host, host.plan, host.findings, host.health(), actionsModuleExports, actions]);
    expect(exposed.has(spawner)).toBe(false);
    for (const value of exposed) {
      expect(isExecutor(value), "an action executor is reachable").toBe(false);
      expect(isAuditStore(value), "the audit store is reachable").toBe(false);
      expect(isRunnerAllowlist(value), "the runner allowlist is reachable").toBe(false);
    }
    // The module's exports are its manifest, its factory and its instance: no runtime state.
    expect(Object.keys(actionsModuleExports).sort()).toEqual(["ACTIONS_MANIFEST", "ACTIONS_STOP_TIMEOUT_MS", "actionsModule", "createActionsModule"]);
  });

  it("builds a fresh runtime per init: two hosts never share an executor", async () => {
    const spawners = [createFakeSpawner({}), createFakeSpawner({})];
    let built = 0;
    const createSpawner = vi.fn((): FakeSpawner => spawners[built++]!);
    const module = createActionsModule({ createSpawner });
    for (const _ of spawners) {
      const { host } = testHost([module], { env: enabledEnv(dataDir()) });
      await host.start();
      cleanups.push(() => host.stop());
    }
    expect(createSpawner).toHaveBeenCalledTimes(2);
  });
});

describe("kernel files no longer name actions", () => {
  const KERNEL_FILES = [
    "src/server/boot.ts",
    "src/server/app.ts",
    "src/server/stop-timings.ts",
    "src/log/logger.ts",
    "../../packages/schema/src/validate/validate.ts",
    "../../packages/schema/src/validate/context.ts",
    "../../packages/schema/src/validate/rules/references.ts",
    "../../packages/schema/src/validate/rules/layers.ts",
    "../../packages/schema/src/compose/builtin.ts",
  ];
  it.each(KERNEL_FILES)("%s", (file) => {
    const text = readFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), "utf8");
    expect(text).not.toMatch(/\baction(s|Run|sMs)?\b|ACTIONS_|DECK_ACTION/i);
  });

  it("the default composition no longer carries modules.actions", () => {
    expect(composeDefault().knownModuleIds).not.toContain("actions");
  });
});
