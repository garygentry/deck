/**
 * The llm-usage module through the module host: its manifest-declared surfaces (the legacy
 * route alias, the health legacy key, the env pointer, the config rule) and the kernel no
 * longer naming the feature.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { LLM_USAGE_UI } from "@deck/contract/modules/llm-usage";
import type { Logger } from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DeckConfig } from "../src/contract/index.js";
import { LlmUsageCollector } from "../src/llm-usage/collector.js";
import { createLlmUsageModule, LLM_USAGE_MANIFEST, llmUsageModule } from "../src/llm-usage/module.js";
import { BUILTIN_MODULES } from "../src/modules/builtin.js";
import { ModuleInitError } from "../src/modules/host.js";
import { createApp } from "../src/server/app.js";
import { testHost } from "./util/modules.js";

const NOW = 1_767_225_600_000;
const providers = { read: () => undefined, count: () => 0, listHealth: () => ({}), listProviders: () => [] };
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;

const collectors: LlmUsageCollector[] = [];
afterEach(() => {
  while (collectors.length) collectors.pop()?.stop();
  vi.useRealTimers();
});

async function started(section: unknown, env: Record<string, string> = {}) {
  const module = createLlmUsageModule({
    createCollector: (config, deps) => {
      const collector = new LlmUsageCollector(config, { ...deps, fetchOauth: async () => ({ ok: true, body: {}, plan: null }) });
      collectors.push(collector);
      return collector;
    },
  });
  const fixture = testHost([module], { sectionOf: () => section, env });
  await fixture.host.start();
  return { ...fixture, app: createApp({ config: {} as DeckConfig, providers, logger, modules: fixture.host }) };
}

const section = { claude: { credentialsFile: "/nonexistent/.credentials.json", statusLine: { credentialEnv: "DECK_LLM_USAGE_INGEST_TOKEN" } } };

describe("llm-usage module", () => {
  it("is a built-in module, always on, with its legacy alias and health key", () => {
    expect(BUILTIN_MODULES).toContain(llmUsageModule);
    expect(LLM_USAGE_MANIFEST).toMatchObject({
      id: "llm-usage",
      contributes: { routes: { legacyAliases: ["/api/llm-usage"] } },
      health: { legacyKey: "llmUsage" },
    });
    expect(LLM_USAGE_MANIFEST.enabledBy).toBeUndefined();
  });

  it("takes its identity and UI contributions from the copy the web half registers against", () => {
    const { id, version, deckApi, contributes } = LLM_USAGE_MANIFEST;
    expect({ id, version, deckApi, contributes }).toEqual(LLM_USAGE_UI);
    expect(contributes).toBe(LLM_USAGE_UI.contributes);
  });

  it("serves byte-identical bodies at /api/m/llm-usage and the legacy /api/llm-usage", async () => {
    vi.useFakeTimers({ now: NOW });
    for (const config of [undefined, section]) {
      const { app } = await started(config);
      const legacy = await app.request("/api/llm-usage");
      const modern = await app.request("/api/m/llm-usage");
      expect(modern.status).toBe(legacy.status);
      expect(modern.headers.get("content-type")).toBe(legacy.headers.get("content-type"));
      expect(await modern.text()).toBe(await legacy.text());
    }
  });

  it("reports not-configured health without a legacy field when the section is absent", async () => {
    const { app } = await started(undefined);
    const body = await (await app.request("/api/health")).json();
    expect(body).not.toHaveProperty("llmUsage");
    expect(body.modules["llm-usage"]).toEqual({ state: "ok", detail: "not configured" });
  });

  it("mirrors the collector's health at llmUsage and in modules", async () => {
    const { app } = await started(section);
    const body = await (await app.request("/api/health")).json();
    expect(body.llmUsage).toEqual({ mode: "paused", lastPollAt: null, consecutiveErrors: 0 });
    expect(body.modules["llm-usage"]).toEqual({ state: "ok", data: body.llmUsage });
  });

  it("reads the operator-named DECK_* ingest token, and logs when it is unset", async () => {
    const on = await started(section, { DECK_LLM_USAGE_INGEST_TOKEN: "t" });
    const pushed = await on.app.request("/api/llm-usage/ingest", { method: "POST", headers: { authorization: "Bearer t" }, body: "{}" });
    expect(pushed.status).toBe(204);

    const off = await started(section);
    expect((await off.app.request("/api/llm-usage/ingest", { method: "POST", body: "{}" })).status).toBe(404);
    expect(off.lines).toContainEqual(expect.objectContaining({
      module: "llm-usage", event: "llm-usage.ingest-disabled", credentialEnv: "DECK_LLM_USAGE_INGEST_TOKEN",
    }));
  });

  it("fails init on a section deck cannot run with", async () => {
    const { host } = testHost([llmUsageModule], { sectionOf: () => ({ idlePause: "not-a-duration" }) });
    const failure = await host.start().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ModuleInitError);
    expect(String((failure as Error).message)).toBe('module "llm-usage" failed to initialise: /modules/llm-usage/idlePause: "not-a-duration" is not an ISO-8601 duration');
  });

  it("stops the collector when the host stops", async () => {
    const { host } = await started(section);
    const collector = collectors.at(-1)!;
    const stop = vi.spyOn(collector, "stop");
    await host.stop();
    expect(stop).toHaveBeenCalledOnce();
  });
});

describe("kernel files no longer name llm-usage", () => {
  const KERNEL_FILES = [
    "src/server/boot.ts",
    "src/server/app.ts",
    "src/contract/api.ts",
    "../../packages/schema/src/validate/validate.ts",
    "../../packages/schema/src/ownership.ts",
    "../../packages/schema/src/compose/builtin.ts",
  ];
  it.each(KERNEL_FILES)("%s", (file) => {
    const text = readFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), "utf8");
    expect(text).not.toMatch(/llm[-_ ]?usage/i);
  });
});
