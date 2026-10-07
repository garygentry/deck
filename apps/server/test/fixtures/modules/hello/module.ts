/**
 * A fixture third-party module that exercises every server contribution point at once: a
 * config section (`modules.hello`), a provider kind (`hello-feed` instances in
 * `integrations[]`), a route (`GET /api/m/hello/greeting`), a config rule (HELLO_SHOUTING) and
 * a health entry. It imports only types from `@deck/module-sdk`, and no kernel file names it:
 * the test hands it to deck beside the built-ins, the way any module is added.
 */
import type { ConfigRule, FindingCodeDecl, JsonObject, ModuleManifest, ProviderOffer, ServerModule } from "@deck/module-sdk";

/** The `modules.hello` section. */
export interface HelloConfig {
  greeting: string;
}

/** What a `hello-feed` provider serves. */
export interface HelloFeedData {
  feed: string;
  greeting: string;
}

/** The finding code the section rule emits. */
export const HELLO_SHOUTING: FindingCodeDecl = {
  code: "HELLO_SHOUTING",
  severity: "warning",
  summary: "The hello greeting is all capitals.",
  fix: "Write the greeting in sentence case.",
};

export const HELLO_MANIFEST: ModuleManifest = {
  id: "hello",
  version: "1.0.0",
  deckApi: "^0.1",
  enabledBy: { config: true },
  config: {
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["greeting"],
      properties: { greeting: { type: "string", minLength: 1 } },
    },
    ownership: { "": "overlay" },
    findings: [HELLO_SHOUTING],
  },
  providerKinds: [
    {
      kind: "hello-feed",
      instanceSchema: {
        type: "object",
        additionalProperties: false,
        required: ["id", "kind", "title", "baseUrl"],
        properties: {
          id: { type: "string" },
          kind: { const: "hello-feed" },
          title: { type: "string" },
          baseUrl: { type: "string" },
        },
      },
    },
  ],
};

/** A greeting with letters in it and none of them lower case, judged on the merged document. */
const shouting: ConfigRule<HelloConfig> = (section, { layer }) =>
  layer === "merged" && /[A-Z]/.test(section.greeting) && section.greeting === section.greeting.toUpperCase()
    ? [{ code: HELLO_SHOUTING.code, path: "/greeting", message: `greeting "${section.greeting}" is all capitals` }]
    : [];

/** The configured greeting in a whole estate document (default "hello"). */
const greetingOf = (estate: Readonly<JsonObject>): string =>
  ((estate.modules as { hello?: Partial<HelloConfig> } | undefined)?.hello?.greeting) ?? "hello";

export const helloModule: ServerModule<HelloConfig> = {
  manifest: HELLO_MANIFEST,
  configRules: [shouting],
  kinds: {
    "hello-feed": {
      // One provider per instance, under the instance's own id.
      instances: (instances: readonly JsonObject[], { estate }): ProviderOffer[] =>
        instances.map((instance) => ({
          provider: {
            id: instance.id as string,
            kind: "hello-feed",
            health: async () => ({ ok: true }),
            fetch: async (): Promise<HelloFeedData> => ({ feed: instance.id as string, greeting: greetingOf(estate) }),
          },
          timing: { pollIntervalMs: 60_000 },
        })),
    },
  },
  init: (ctx) => {
    const greeting = ctx.config?.greeting ?? "hello";
    ctx.http.get("/greeting", (c) => c.json({ greeting }));
    ctx.health.report(() => ({ state: "ok", detail: `greeting: ${greeting}` }));
  },
};
