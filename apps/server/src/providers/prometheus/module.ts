import { defineServerModule, type JsonSchema, type ModuleManifest } from "@deck/module-sdk";

import { PrometheusProvider } from "./index.js";
import instanceSchema from "./instance.schema.json" with { type: "json" };
import { parseSummaryCard } from "./parse-card.js";

/**
 * The `prometheus` data source: the first `integrations[]` instance of kind `prometheus`
 * becomes the provider `prometheus`, running the summary queries its `card.summaries`
 * declares (parsed here; an invalid entry is dropped with a warning on the module's logger, never
 * failing boot). The kind is not bindable: a host or service binding of it is reported
 * (`PROVIDER_BINDING_UNSUPPORTED`) and ignored.
 */
export const PROMETHEUS_MANIFEST: ModuleManifest = {
  id: "prometheus",
  version: "1.0.0",
  deckApi: "^0.1",
  providerKinds: [{ kind: "prometheus", fixedId: "prometheus", instanceSchema: instanceSchema as JsonSchema, statusCapable: false }],
};

export const prometheusModule = defineServerModule(PROMETHEUS_MANIFEST, () => {}, {
  kinds: {
    prometheus: {
      instances: ([first], { envFor, logger }) => {
        if (first === undefined) return [];
        const config = {
          baseUrl: first.baseUrl as string,
          summaries: parseSummaryCard(first.card, logger),
          // Only this instance's credential: a later same-kind instance is never read.
          ...(typeof first.credentialEnv === "string"
            ? { credentialEnv: first.credentialEnv, env: envFor(first) }
            : { env: envFor(first) }),
        };
        // The web polls `prometheus` by id: no other provider may take it.
        return [{ provider: new PrometheusProvider("prometheus", config), fixedId: true }];
      },
    },
  },
});
