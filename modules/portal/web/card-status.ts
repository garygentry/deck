import type { Service } from "@deck/schema";
import type { GroupItem, LinkItem, ServiceItem } from "../server/types.js";
import type { FreshnessStamp, ProviderEnvelope } from "@deck/contract";
import { BUILTIN_STATUS_KINDS } from "@deck/contract/modules/data-sources";
import type { StatusConditionDecl, UiStatusKind } from "@deck/module-sdk";
import { bindingProviderId, serviceOwner } from "@deck/schema/provider-ids";
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
  | "pending"
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

/** What a card's status is derived from: the status kinds and the providers the cards read. */
export interface CardStatusContext {
  /** The provider kinds whose bindings give a card its status (the UI manifest's `statusKinds`). */
  statusKinds: readonly UiStatusKind[];
  /**
   * The registered provider ids (the UI manifest's `providers`): a binding whose provider is
   * not one gives no status, so the next binding can. `null` when unknown (no manifest).
   */
  registered: ReadonlySet<string> | null;
  /** The envelope of each provider a card reads, by id; `null` when it is not configured or unreadable. */
  envelopes: ReadonlyMap<string, ProviderEnvelope | null>;
  /** Providers whose first read has not settled: their cards say so, the rest render. */
  pending: ReadonlySet<string>;
}

export interface PortalData extends CardStatusContext {
  config: DeckConfig | null;
  /** True only until the config and the UI manifest first settle; never again after. */
  loading: boolean;
}

export type CardItem = ServiceItem | LinkItem;

/** A service's status binding: the kind that gives it a status, the provider it reads, and the binding itself. */
export interface StatusBinding {
  kind: UiStatusKind;
  providerId: string;
  value: Readonly<Record<string, unknown>>;
}

/** The built-in status kinds, which a service's bindings consult first, in this order. */
const BUILTIN_ORDER = new Map(BUILTIN_STATUS_KINDS.map((kind, index) => [`${kind.module}/${kind.kind}`, index]));

/** Status kinds in precedence order: the built-ins in their fixed order, then the others by kind name. */
export function byPrecedence(kinds: readonly UiStatusKind[]): UiStatusKind[] {
  const rank = (kind: UiStatusKind): number => BUILTIN_ORDER.get(`${kind.module}/${kind.kind}`) ?? BUILTIN_ORDER.size;
  return [...kinds].sort((a, b) => rank(a) - rank(b) || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));
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

/**
 * The binding that gives a service its card status: of the status kinds it binds, in
 * precedence order ({@link byPrecedence}), the first whose binding is usable (an object, naming
 * the item when the kind matches one in a list) and whose provider is registered (when that is
 * known). `null` when there is none, so its card is static.
 */
export function resolveServiceBinding(
  service: Service,
  kinds: readonly UiStatusKind[],
  registered: ReadonlySet<string> | null = null,
): StatusBinding | null {
  const bindings = service.bindings as Record<string, unknown> | undefined;
  for (const kind of byPrecedence(kinds)) {
    const value = bindings?.[kind.kind];
    if (!isRecord(value)) continue;
    const match = kind.status.match;
    if (match !== undefined && !isKey(readPath(value, match.binding))) continue;
    const providerId = kind.status.provider === "fixed"
      ? kind.fixedId
      : bindingProviderId(kind.kind, serviceOwner(service.host, service.name), value);
    if (providerId === undefined || (registered !== null && !registered.has(providerId))) continue;
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
 * reference; a service with no status binding is static; a binding whose provider has not
 * answered yet is pending; otherwise its binding's provider says whether it is unreachable (no
 * envelope, an error, unreachable freshness or no data), the item is not found, or the item is
 * up or down by its kind's conditions.
 */
export function deriveCardStatus(
  item: CardItem,
  resolvedService: Service | undefined,
  context: CardStatusContext,
): CardStatus {
  if (item.type === "link") {
    return "static";
  }
  if (resolvedService === undefined) {
    return "broken-reference";
  }
  const binding = resolveServiceBinding(resolvedService, context.statusKinds, context.registered);
  if (binding === null) {
    return "static";
  }
  if (context.pending.has(binding.providerId)) return "pending";
  const envelope = context.envelopes.get(binding.providerId) ?? null;
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
