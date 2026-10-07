import { describe, expectTypeOf, it } from "vitest";

import {
  type ConfigRule,
  type ConfigRuleFinding,
  defineServerModule,
  defineWebModule,
  type ModuleConfigDecl,
  type ModuleHealth,
  type ModuleManifest,
  type ProviderSpec,
  type ReferenceDecl,
  type ServerModuleContext,
  type TaskHandle,
  type UniqueDecl,
} from "../src/index.js";
import { pilotManifest } from "./pilot-manifest.js";

interface PilotConfig {
  idlePause?: string;
  claude?: { statusLine?: { credentialEnv?: string } };
}

describe("pilot manifest types", () => {
  it("compiles the pilot's server half against the context", () => {
    const module = defineServerModule<PilotConfig>(pilotManifest, async (ctx) => {
      expectTypeOf(ctx).toEqualTypeOf<ServerModuleContext<PilotConfig>>();
      expectTypeOf(ctx.config).toEqualTypeOf<PilotConfig | undefined>();
      const credentialEnv = ctx.config?.claude?.statusLine?.credentialEnv;
      const token = credentialEnv ? ctx.env.get(credentialEnv) : undefined;
      expectTypeOf(token).toEqualTypeOf<string | undefined>();

      const task = ctx.scheduler.schedule({
        name: "poll",
        run: async () => {},
        cadence: ({ lastRunAt, now }) => (lastRunAt === null ? 0 : Math.max(0, lastRunAt + 120_000 - now)),
      });
      expectTypeOf(task).toEqualTypeOf<TaskHandle>();

      ctx.http.get("/", (c) => c.json({ enabled: true }));
      ctx.http.get("/refresh", async (c) => {
        await task.runNow();
        return c.json({ enabled: true });
      });
      ctx.health.report((): ModuleHealth => ({ state: "ok", data: { mode: "idle", lastPollAt: null, consecutiveErrors: 0 } }));
      ctx.onStop(() => task.stop());
      ctx.logger.info({ event: "llm-usage.ready", token: token !== undefined });
    });
    expectTypeOf(module.manifest).toEqualTypeOf<ModuleManifest>();
  });

  it("compiles the pilot's web half as a component table", () => {
    const UsagePage = () => null;
    const web = defineWebModule(pilotManifest, { components: { UsagePage } });
    expectTypeOf(web.components.UsagePage).toEqualTypeOf<typeof UsagePage>();
  });

  it("rejects non-JSON manifest values at compile time", () => {
    const bad = {
      ...pilotManifest,
      // @ts-expect-error a function is not JSON
      config: { schema: { default: () => 1 } },
    } satisfies ModuleManifest;
    void bad;
    // @ts-expect-error extension ids are `<kind>:<module>/<name>`
    const badId: ModuleManifest = { ...pilotManifest, contributes: { pages: [{ id: "usage", path: "/u", title: "U", component: "P" }] } };
    void badId;
  });

  it("routes a provider kind's instance schema to an instance list in the manifest", () => {
    const manifest = {
      ...pilotManifest,
      providerKinds: [
        { kind: "json-api", instanceSchema: { type: "object" }, instanceList: "integrations" },
        { kind: "notes", instanceList: "sources" },
      ],
    } satisfies ModuleManifest;
    void manifest;
    // @ts-expect-error instances live in `integrations` or `sources` only
    const bad: ModuleManifest = { ...pilotManifest, providerKinds: [{ kind: "x", instanceList: "hosts" }] };
    void bad;
  });

  it("puts config rules on the server module, typed by the section, never on the manifest", () => {
    const thresholds: ConfigRule<PilotConfig> = (section, { layer }) => {
      expectTypeOf(section).toEqualTypeOf<PilotConfig>();
      expectTypeOf(layer).toEqualTypeOf<"base" | "overlay" | "merged">();
      return section.idlePause === "PT0S" ? [{ code: "LLM_USAGE_INVALID", path: "/idlePause", message: "zero" }] : [];
    };
    const module = defineServerModule<PilotConfig>(pilotManifest, () => {}, { configRules: [thresholds] });
    expectTypeOf(module.configRules).toEqualTypeOf<readonly ConfigRule<PilotConfig>[] | undefined>();
    expectTypeOf<ReturnType<ConfigRule>>().toEqualTypeOf<readonly ConfigRuleFinding[]>();
    // @ts-expect-error a rule is a function, and the manifest is pure data (no configRules key)
    const bad: ModuleManifest = { ...pilotManifest, configRules: [thresholds] };
    void bad;
  });

  it("declares references in string or object form, and id namespaces as data", () => {
    const config = {
      schema: { type: "object" },
      references: [
        "jobs[].target",
        { path: "groups[].items[]", service: "name", at: "element" },
        { path: "links[]", host: "machine" },
      ],
      unique: [{ paths: ["groups[]", "groups[].items[]"], key: ["id"], message: "Group id {key} is repeated." }],
    } satisfies ModuleConfigDecl;
    expectTypeOf(config.references[1]).toMatchTypeOf<ReferenceDecl>();
    expectTypeOf<UniqueDecl["message"]>().toEqualTypeOf<string | undefined>();
    // @ts-expect-error `at` is "field" or "element"
    const badAt: ReferenceDecl = { path: "x[]", at: "value" };
    // @ts-expect-error the object form needs a path
    const noPath: ReferenceDecl = { service: "name" };
    // @ts-expect-error a namespace lists its key fields
    const noKey: UniqueDecl = { paths: ["groups[]"] };
    void [badAt, noPath, noKey];
  });

  it("keeps ProviderSpec a structural match for providers", () => {
    const provider: ProviderSpec<{ up: boolean }> = {
      id: "x",
      kind: "http-health",
      health: async () => ({ ok: true }),
      fetch: async () => ({ up: true }),
    };
    expectTypeOf(provider.fetch).returns.resolves.toEqualTypeOf<{ up: boolean }>();
  });
});
