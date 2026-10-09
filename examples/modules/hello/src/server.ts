// The server half. It runs inside deck's process and imports nothing from deck at runtime:
// everything it uses comes through `ctx`, and `@deck/module-sdk` is imported for types only.
// The build bundles anything else it imports into server.mjs.
import type { ModuleManifest, ServerModule } from "@deck/module-sdk";

import manifest from "../deck-module.json";
import { DEFAULT_GREETING, type Greeting, type HelloConfig } from "./greeting";

const hello: ServerModule<HelloConfig> = {
  // deck checks at load that this equals the deck-module.json beside the entry.
  manifest: manifest as ModuleManifest,
  init(ctx) {
    const message = ctx.config?.greeting ?? DEFAULT_GREETING;
    // A provider: polled by deck and served at /api/providers/hello.
    ctx.providers.register<Greeting>(
      {
        id: "hello",
        kind: "hello",
        health: async () => ({ ok: true }),
        fetch: async () => ({ message, servedAt: new Date(ctx.clock.now()).toISOString() }),
      },
      { pollIntervalMs: 60_000 },
    );
    // A route of the module's own: GET /api/m/hello/greeting.
    ctx.http.get("/greeting", (c) => c.json({ message }));
    ctx.health.report(() => ({ state: "ok", detail: message }));
  },
};

export default hello;
