import { defineServerModule, type JsonSchema, type ModuleManifest } from "@deck/module-sdk";

import { GatusProvider } from "./index.js";
import instanceSchema from "./instance.schema.json" with { type: "json" };

/**
 * The `gatus` data source: the first `integrations[]` instance of kind `gatus` becomes the
 * provider `gatus`. A host or service binding of this kind registers nothing; it selects
 * entries from that provider's data, which the portal reads for card status.
 */
export const GATUS_MANIFEST: ModuleManifest = {
  id: "gatus",
  version: "1.0.0",
  deckApi: "^0.1",
  providerKinds: [{ kind: "gatus", fixedId: "gatus", instanceSchema: instanceSchema as JsonSchema, bindable: true, statusCapable: true }],
};

export const gatusModule = defineServerModule(GATUS_MANIFEST, () => {}, {
  kinds: {
    gatus: {
      binding: () => [],
      instances: ([first], { envFor }) => {
        if (first === undefined) return [];
        const config = {
          baseUrl: first.baseUrl as string,
          ...(typeof first.credentialEnv === "string" ? { credentialEnv: first.credentialEnv } : {}),
          // Only this instance's credential: a later same-kind instance is never read.
          env: envFor(first),
        };
        // The web polls this id literally: it is reserved like an estate id.
        return [{ provider: new GatusProvider("gatus", config), fixedId: true }];
      },
    },
  },
});
