import { HTTP_HEALTH_STATUS } from "@deck/contract/modules/data-sources";
import { defineServerModule, type ModuleManifest, type ProviderTiming } from "@deck/module-sdk";

import { HttpHealthProvider, type HttpHealthConfig } from "./index.js";

/**
 * The `http-health` data source: a host or service binding `{ url, method?, timing? }`
 * becomes a provider that probes the URL on every poll.
 */
export const HTTP_HEALTH_MANIFEST: ModuleManifest = {
  id: "http-health",
  version: "1.0.0",
  deckApi: "^0.1",
  providerKinds: [{ kind: "http-health", bindable: true, statusCapable: true, status: HTTP_HEALTH_STATUS }],
};

/** The numeric timing fields of a binding's `timing` object; anything else is dropped. */
function timing(value: unknown): ProviderTiming | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  return {
    ...(typeof raw.pollIntervalMs === "number" ? { pollIntervalMs: raw.pollIntervalMs } : {}),
    ...(typeof raw.ttlMs === "number" ? { ttlMs: raw.ttlMs } : {}),
    ...(typeof raw.unreachableAfterMs === "number" ? { unreachableAfterMs: raw.unreachableAfterMs } : {}),
    ...(typeof raw.timeoutMs === "number" ? { timeoutMs: raw.timeoutMs } : {}),
  };
}

export const httpHealthModule = defineServerModule(HTTP_HEALTH_MANIFEST, () => {}, {
  kinds: {
    "http-health": {
      binding: ({ id, value }) => {
        if (typeof value.url !== "string") return [];
        const resolvedTiming = timing(value.timing);
        const config: HttpHealthConfig = {
          url: value.url,
          ...(value.method === "GET" || value.method === "HEAD" ? { method: value.method } : {}),
          ...(resolvedTiming ? { timing: resolvedTiming } : {}),
        };
        return [{ provider: new HttpHealthProvider(id, config), ...(config.timing ? { timing: config.timing } : {}) }];
      },
    },
  },
});
