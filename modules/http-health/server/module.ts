import { HTTP_HEALTH_STATUS } from "@deck/contract/modules/data-sources";
import { defineServerModule, type ConfigRuleFinding, type JsonObject, type ModuleManifest, type ProviderTiming } from "@deck/module-sdk";

import { HttpHealthProvider, type HttpHealthConfig } from "./index.js";

/**
 * The `http-health` data source: a host or service binding `{ url, method?, timing? }`
 * becomes a provider that probes the URL on every poll.
 */
export const HTTP_HEALTH_MANIFEST: ModuleManifest = {
  id: "http-health",
  version: "1.0.0",
  deckApi: "^0.1",
  providerKinds: [
    {
      kind: "http-health",
      bindable: true,
      statusCapable: true,
      status: HTTP_HEALTH_STATUS,
      findings: [
        {
          code: "HTTP_HEALTH_TIMING_INVALID",
          severity: "error",
          summary: "An http-health binding's timing field is not a positive, finite number of milliseconds.",
          fix: "Give the timing field a number of milliseconds above 0, or remove it to use the default.",
        },
      ],
    },
  ],
};

const TIMING_FIELDS = ["pollIntervalMs", "ttlMs", "unreachableAfterMs", "timeoutMs"] as const;

/** A timing value deck can schedule with: a positive, finite number of milliseconds. */
function isDuration(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/**
 * The timing fields of a binding's `timing` object that are positive, finite numbers; anything
 * else is dropped (config validation reports it), so a poll interval of 0 never reaches the
 * scheduler.
 */
function timing(value: unknown): ProviderTiming | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const resolved: ProviderTiming = {};
  for (const field of TIMING_FIELDS) if (isDuration(raw[field])) resolved[field] = raw[field];
  return resolved;
}

/** What config validation reports for one http-health binding. Pure. */
function validateBinding(binding: JsonObject): ConfigRuleFinding[] {
  const raw = binding.timing;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return [];
  return TIMING_FIELDS.filter((field) => raw[field] !== undefined && !isDuration(raw[field])).map((field) => ({
    code: "HTTP_HEALTH_TIMING_INVALID",
    path: `/timing/${field}`,
    message: `timing.${field} must be a positive, finite number of milliseconds; the default is used instead.`,
  }));
}

export const httpHealthModule = defineServerModule(HTTP_HEALTH_MANIFEST, () => {}, {
  kinds: {
    "http-health": {
      validateBinding,
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
