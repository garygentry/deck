import type { Service } from "@deck/schema";
import type { GroupItem, LinkItem, ServiceItem } from "@deck/server/portal";
import type { FreshnessStamp, ProviderEnvelope } from "@deck/contract";
import type { StatusConditionDecl, UiStatusKind } from "@deck/module-sdk";
import type { DeckConfig } from "@deck/server";

export interface GatusEndpoint {
  key: string;
  name?: string;
  group?: string;
  up: boolean;
  latencyMs: number | null;
}

export interface GatusResult {
  endpoints: GatusEndpoint[];
}

export type CardStatus =
  | "static"
  | "broken-reference"
  | "unreachable"
  | "not-found"
  | "bound-up"
  | "bound-down";

export type LiveStatusBucket = "up" | "down" | "unreachable";

export function statusBucket(status: CardStatus): LiveStatusBucket | null {
  switch (status) {
    case "bound-up":
      return "up";
    case "bound-down":
      return "down";
    case "unreachable":
      return "unreachable";
    default:
      return null;
  }
}

export interface CardViewModel {
  item: GroupItem;
  resolvedService?: Service;
  status: CardStatus;
  target?: string;
  freshness: FreshnessStamp;
}

export interface PortalData {
  config: DeckConfig | null;
  /** The provider kinds whose bindings give a card its status (the UI manifest's `statusKinds`). */
  statusKinds: readonly UiStatusKind[];
  /** The envelope of each provider a card reads, by id; `null` when it is not configured or unreadable. */
  envelopes: ReadonlyMap<string, ProviderEnvelope | null>;
  loading: boolean;
}

export type CardItem = ServiceItem | LinkItem;

/** A service's status binding: the kind that gives it a status, the provider it reads, and the binding itself. */
export interface StatusBinding {
  kind: UiStatusKind;
  providerId: string;
  value: Readonly<Record<string, unknown>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The value at a key path (`a.b`) of `value`, through own keys of plain objects only. */
export function readPath(value: unknown, path: string): unknown {
  let current = value;
  for (const key of path.split(".")) {
    if (!isRecord(current) || !Object.hasOwn(current, key)) return undefined;
    current = current[key];
  }
  return current;
}

/** The binding's own id, else the id the server gives it (`<kind>:service:<host>:<name>`). */
function bindingProviderId(kind: string, service: Service, value: Readonly<Record<string, unknown>>): string {
  return typeof value.id === "string" ? value.id : `${kind}:service:${service.host}:${service.name}`;
}

/**
 * The binding that gives a service its card status: of the status kinds it binds, the first
 * by kind name whose binding is usable (an object, naming the item when the kind matches one in
 * a list). `null` when it binds none, so its card is static.
 */
export function resolveServiceBinding(service: Service, kinds: readonly UiStatusKind[]): StatusBinding | null {
  const bindings = service.bindings as Record<string, unknown> | undefined;
  for (const kind of [...kinds].sort((a, b) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0))) {
    const value = bindings?.[kind.kind];
    if (!isRecord(value)) continue;
    const match = kind.status.match;
    if (match !== undefined && !isKey(readPath(value, match.binding))) continue;
    const providerId = kind.status.provider === "fixed" ? kind.fixedId : bindingProviderId(kind.kind, service, value);
    if (providerId === undefined) continue;
    return { kind, providerId, value };
  }
  return null;
}

function isKey(value: unknown): value is string | number {
  return typeof value === "string" || typeof value === "number";
}

/** The item a binding reads in its provider's data, or `undefined` when there is none. */
export function boundItem(data: unknown, binding: StatusBinding): unknown {
  const match = binding.kind.status.match;
  if (match === undefined) return data;
  const list = readPath(data, match.list);
  if (!Array.isArray(list)) return undefined;
  const key = readPath(binding.value, match.binding);
  return list.find((entry) => readPath(entry, match.key) === key);
}

/** Whether every condition holds on the item. */
export function isUp(item: unknown, conditions: readonly StatusConditionDecl[]): boolean {
  return conditions.every(({ field, in: values }) => values.includes(readPath(item, field) as string | number | boolean));
}

/**
 * A card's status: a link is static; a service item naming no declared service is a broken
 * reference; a service with no status binding is static; otherwise its binding's provider says
 * whether it is unreachable (no envelope, an error, unreachable freshness or no data), the item
 * is not found, or the item is up or down by its kind's conditions.
 */
export function deriveCardStatus(
  item: CardItem,
  resolvedService: Service | undefined,
  kinds: readonly UiStatusKind[],
  envelopes: ReadonlyMap<string, ProviderEnvelope | null>,
): CardStatus {
  if (item.type === "link") {
    return "static";
  }
  if (resolvedService === undefined) {
    return "broken-reference";
  }
  const binding = resolveServiceBinding(resolvedService, kinds);
  if (binding === null) {
    return "static";
  }
  const envelope = envelopes.get(binding.providerId) ?? null;
  if (
    envelope === null ||
    envelope.error !== null ||
    envelope.freshness.state === "unreachable" ||
    envelope.data === null
  ) {
    return "unreachable";
  }
  const target = boundItem(envelope.data, binding);
  if (target === undefined) return "not-found";
  return isUp(target, binding.kind.status.up) ? "bound-up" : "bound-down";
}
