import type { LlmUsageHealth } from "../llm-usage/types.js";
import type { ProviderHealth } from "./provider.js";

export interface ApiError {
  error: string;
  code?: string;
}

/** Latest non-I/O health snapshot for one registered provider. */
export interface ProviderHealthEntry extends ProviderHealth {
  /** Provider kind used for diagnosis and grouping. */
  kind: string;
}

/** Cached readiness response; reading it performs no provider I/O. */
export interface HealthResponse {
  /** Degraded when one or more providers' latest health is not ok. */
  status: "ok" | "degraded";
  /** Milliseconds since app construction. */
  uptimeMs: number;
  /** Number of registered providers. */
  providerCount: number;
  /** Provider health keyed by id in deterministic id order. */
  providers: Record<string, ProviderHealthEntry>;
  /** LLM usage collector state; present only when the `llmUsage` section is configured. */
  llmUsage?: LlmUsageHealth;
}

export interface ProviderParams {
  id: string;
}

/** One registered provider's identity, exposed so the web polls only what exists. */
export interface ProviderDescriptor {
  /** Provider id and route segment (`/api/providers/:id`). */
  id: string;
  /** Provider kind. */
  kind: string;
}

/** Registry discovery response; reading it performs no provider I/O. */
export interface ProvidersResponse {
  /** Registered providers in deterministic id order. */
  providers: ProviderDescriptor[];
}

/**
 * Actions capability probe. Answered with HTTP 200 whether or not the capability
 * is enabled, so the web can gate its audit poll without provoking a 403.
 */
export interface ActionsCapabilityResponse {
  /** True only when the governed-actions runtime is configured and enabled. */
  enabled: boolean;
}
