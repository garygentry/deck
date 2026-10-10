import type { DriftFindingProjection, DriftProjection } from "@deck/drift";
import {
  findHost,
  findService,
  hostHref,
  serviceHref,
} from "@/features/hosts-and-services/model.js";
import type { InventoryModel } from "@/features/hosts-and-services/model.js";
import type { DriftGenerationState } from "./store.js";

// Helpers shared by the drift page, the entity fragments and the header summary,
// so each surface reads the same generation the same way.

/** A resolved detail link, or an unresolved location with no anchor. */
export interface ResolvedLocation {
  /** Detail route, or null when no safe anchor can be emitted. */
  readonly href: string | null;
  /** Accessible link text when a route exists, otherwise null. */
  readonly linkLabel: string | null;
}

/** The fixed unresolved result shared by every no-link branch. */
const UNRESOLVED: ResolvedLocation = Object.freeze({ href: null, linkLabel: null });

/**
 * Resolve a finding's detail route against the matching accepted model: exact
 * service first, then host fallback (even for an unresolved service name), then
 * an unresolved location with no anchor. A route-helper `URIError` for a
 * non-encodable in-memory identity also yields the unresolved result; no broken
 * or partial route is ever emitted.
 */
export function resolveFindingLocation(
  finding: DriftFindingProjection,
  model: InventoryModel,
): ResolvedLocation {
  const { host, service } = finding;
  try {
    if (service !== null && findService(model, host, service) !== undefined) {
      return {
        href: serviceHref(host, service),
        linkLabel: `View service ${service} on ${host}`,
      };
    }
    if (findHost(model, host) !== undefined) {
      return { href: hostHref(host), linkLabel: `View host ${host}` };
    }
  } catch (error) {
    if (error instanceof URIError) return UNRESOLVED;
    throw error;
  }
  return UNRESOLVED;
}

/**
 * Resolve a host's detail route, or null for a missing host or a route-helper
 * `URIError` (the host text stays, with no anchor).
 */
export function resolveHostHref(model: InventoryModel, host: string): string | null {
  try {
    if (findHost(model, host) !== undefined) return hostHref(host);
  } catch (error) {
    if (error instanceof URIError) return null;
    throw error;
  }
  return null;
}

/** True when a retained generation carries a current refresh/read/derive failure. */
export function hasRetainedFailure(
  state: DriftGenerationState,
  projection: DriftProjection,
): boolean {
  return (
    state.inventory.transientError !== null ||
    projection.readError !== null ||
    state.derivationError !== null
  );
}

/** Why no usable drift generation exists yet, in precedence order. */
export type NoGeneration =
  /** The snapshot is available but the first derivation failed. */
  | { readonly kind: "derivation-failed"; readonly detail: string }
  /** No snapshot provider is configured. */
  | { readonly kind: "not-configured" }
  /** The first snapshot read failed upstream; `detail` is the sanitized envelope error. */
  | { readonly kind: "read-failed"; readonly detail: string | null }
  /** The first snapshot/config request failed; `detail` is the sanitized client message. */
  | { readonly kind: "request-failed"; readonly detail: string }
  /** The first snapshot read has not completed. */
  | { readonly kind: "pending" }
  /** Inventory data is still loading. */
  | { readonly kind: "loading" }
  /** Nothing usable and no more specific reason. */
  | { readonly kind: "unavailable" };

/** Classify a generation state that has no accepted projection. */
export function classifyNoGeneration(state: DriftGenerationState): NoGeneration {
  const { inventory, derivationError } = state;
  const snapshot = inventory.snapshot;

  if (snapshot.status === "available" && derivationError !== null) {
    return { kind: "derivation-failed", detail: derivationError };
  }
  if (snapshot.status === "not-configured") return { kind: "not-configured" };
  if (snapshot.status === "failed-empty") {
    return { kind: "read-failed", detail: snapshot.envelope.error?.message ?? null };
  }
  if (snapshot.status === "request-error") {
    return { kind: "request-failed", detail: snapshot.message };
  }
  const clientError = inventory.configError ?? inventory.transientError;
  if (clientError !== null) return { kind: "request-failed", detail: clientError };
  if (snapshot.status === "pending") return { kind: "pending" };
  if (inventory.loading) return { kind: "loading" };
  return { kind: "unavailable" };
}
