import type { InventoryModel } from "../hosts-and-services/model.js";
import { findHost, findService } from "../hosts-and-services/model.js";

/** Exact entity identity carried by a `/drift` URL scope. */
export interface DriftEntityScope {
  /** Exact host identity required by every entity scope. */
  readonly host: string;
  /** Exact service identity for a service scope; absent for a host scope. */
  readonly service?: string;
}

/** Stable failure classification for a recoverable scope problem. */
export type DriftScopeErrorCode =
  | "EMPTY_VALUE"
  | "DUPLICATE_VALUE"
  | "SERVICE_WITHOUT_HOST"
  | "MALFORMED_ENCODING"
  | "UNKNOWN_ENTITY";

/** Result of parsing and/or resolving a `/drift` entity scope. Never thrown. */
export type DriftScopeResult =
  | {
      /** No entity query is active. */
      readonly status: "unscoped";
    }
  | {
      /** URL syntax and (when resolved) entity identity succeeded. */
      readonly status: "scoped";
      /** Resolved exact entity identity. */
      readonly scope: DriftEntityScope;
    }
  | {
      /** URL syntax or entity resolution failed without throwing. */
      readonly status: "no-match";
      /** Stable failure classification used by presentation logic. */
      readonly code: DriftScopeErrorCode;
      /** Fixed sanitized user-facing explanation. */
      readonly message: string;
    };

/**
 * Fixed, sanitized explanations for each recoverable scope failure. No user-
 * controlled URL text is ever interpolated into these strings.
 */
const SCOPE_MESSAGES: Readonly<Record<DriftScopeErrorCode, string>> =
  Object.freeze({
    EMPTY_VALUE:
      "The entity scope in the address is empty. Showing all drift and coverage.",
    DUPLICATE_VALUE:
      "The entity scope in the address has duplicate values. Showing all drift and coverage.",
    SERVICE_WITHOUT_HOST:
      "The entity scope names a service without a host. Showing all drift and coverage.",
    MALFORMED_ENCODING:
      "The entity scope in the address is malformed. Showing all drift and coverage.",
    UNKNOWN_ENTITY:
      "No matching host or service was found for the entity scope. Showing all drift and coverage.",
  });

/** Build a frozen `no-match` result carrying the fixed message for its code. */
function noMatch(code: DriftScopeErrorCode): DriftScopeResult {
  return Object.freeze({ status: "no-match", code, message: SCOPE_MESSAGES[code] });
}

const UNSCOPED: DriftScopeResult = Object.freeze({ status: "unscoped" });

/**
 * Build a stable `/drift` href for one entity scope using `URLSearchParams`, so
 * reserved characters and Unicode round-trip through `parseDriftScope`. A service
 * scope always carries its host.
 */
export function driftScopeHref(scope: DriftEntityScope): string {
  const params = new URLSearchParams();
  params.set("host", scope.host);
  if (scope.service !== undefined) {
    params.set("service", scope.service);
  }
  return `/drift?${params.toString()}`;
}

/**
 * Isolate the raw query substring after `?`, excluding any `#fragment`. Accepts a
 * full URL, a `?query` string, or a bare `key=value` query.
 */
function isolateRawQuery(search: string): string {
  const hashIndex = search.indexOf("#");
  const withoutFragment = hashIndex === -1 ? search : search.slice(0, hashIndex);
  const queryIndex = withoutFragment.indexOf("?");
  return queryIndex === -1 ? withoutFragment : withoutFragment.slice(queryIndex + 1);
}

/**
 * Pre-scan the raw `host`/`service` values for malformed percent encoding before
 * `URLSearchParams` — whose lossy decoder replaces malformed sequences rather than
 * throwing — can mask them. Returns a `MALFORMED_ENCODING` result on the first
 * `URIError`, otherwise null.
 */
function detectMalformedEncoding(rawQuery: string): DriftScopeResult | null {
  for (const segment of rawQuery.split("&")) {
    if (segment === "") continue;
    const equals = segment.indexOf("=");
    const rawKey = equals === -1 ? segment : segment.slice(0, equals);
    if (rawKey !== "host" && rawKey !== "service") continue;
    const rawValue = equals === -1 ? "" : segment.slice(equals + 1);
    try {
      decodeURIComponent(rawValue);
    } catch {
      return noMatch("MALFORMED_ENCODING");
    }
  }
  return null;
}

/**
 * Parse a URL/query string into a `DriftScopeResult` describing its syntactic
 * scope. Detects malformed encoding, duplicate, empty, and service-only queries;
 * ignores unrelated keys; and returns the exact decoded identity for a valid
 * scope. Identity is not yet resolved against inventory. Never throws.
 */
export function parseDriftScope(search: string): DriftScopeResult {
  const rawQuery = isolateRawQuery(search);

  const malformed = detectMalformedEncoding(rawQuery);
  if (malformed !== null) return malformed;

  const params = new URLSearchParams(rawQuery);
  const hosts = params.getAll("host");
  const services = params.getAll("service");

  if (hosts.length > 1 || services.length > 1) return noMatch("DUPLICATE_VALUE");

  const host = hosts.length === 1 ? hosts[0] : null;
  const service = services.length === 1 ? services[0] : null;

  if (host === "" || service === "") return noMatch("EMPTY_VALUE");
  if (service !== null && host === null) return noMatch("SERVICE_WITHOUT_HOST");
  if (host === null) return UNSCOPED;

  const scope: DriftEntityScope =
    service !== null ? { host, service } : { host };
  return Object.freeze({ status: "scoped", scope: Object.freeze(scope) });
}

/**
 * Resolve a parsed scope against the accepted inventory model. Passes `unscoped`
 * and `no-match` through unchanged; converts an unknown host or `(host, service)`
 * identity into a recoverable `UNKNOWN_ENTITY` result; preserves the identity on
 * success. Never throws for user-controlled input.
 */
export function resolveDriftScope(
  result: DriftScopeResult,
  model: InventoryModel,
): DriftScopeResult {
  if (result.status !== "scoped") return result;

  const { host, service } = result.scope;
  if (service !== undefined) {
    // `findService` validates the exact `(host, service)` pair together.
    return findService(model, host, service) !== undefined
      ? result
      : noMatch("UNKNOWN_ENTITY");
  }
  return findHost(model, host) !== undefined ? result : noMatch("UNKNOWN_ENTITY");
}
