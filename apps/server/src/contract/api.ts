import type { ApiErrorBody, ModuleHealthEntry } from "@deck/module-sdk";

import type { ProviderHealth } from "./provider.js";

/** The API error envelope every route uses (shared with modules through the SDK). */
export type ApiError = ApiErrorBody;

/** Latest non-I/O health snapshot for one registered provider. */
export interface ProviderHealthEntry extends ProviderHealth {
  /** Provider kind used for diagnosis and grouping. */
  kind: string;
}

/**
 * Top-level `/api/health` fields that mirror a module's health `data` (its manifest's
 * `health.legacyKey`), for fields that predate the module. Each module declares its own
 * field by augmenting this interface, so the kernel contract names no module.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface LegacyHealthFields {}

/** Cached readiness response; reading it performs no provider I/O. */
export interface HealthResponse extends LegacyHealthFields {
  /** Degraded when one or more providers' latest health is not ok. */
  status: "ok" | "degraded";
  /** Milliseconds since app construction. */
  uptimeMs: number;
  /** Number of registered providers. */
  providerCount: number;
  /** Provider health keyed by id in deterministic id order. */
  providers: Record<string, ProviderHealthEntry>;
  /**
   * Every known module's health by id, in id order; disabled modules report why. Module
   * health never affects `status`.
   */
  modules: Record<string, ModuleHealthEntry>;
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
