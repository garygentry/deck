import type { LinkItem, ServiceItem } from "@deck/schema";
import type { FilterAccessors } from "@/ui";
import {
  statusBucket,
  type CardViewModel,
  type LiveStatusBucket,
} from "./card-status.js";

export interface IndexedCard {
  card: CardViewModel;
  groupId: string;
  groupTitle: string;
}

/** The portal's two facets: live status bucket and top-level group. */
export type PortalFacet = "status" | "group";

export const PORTAL_FACETS: readonly PortalFacet[] = ["status", "group"];

/** The live status buckets offered as filters, in display order. */
export const STATUS_FILTERS: readonly LiveStatusBucket[] = ["up", "down", "unreachable"];

export function cardSearchFields(entry: IndexedCard): string[] {
  const fields = [entry.groupTitle];
  const item = entry.card.item;

  if (item.type === "service") {
    const serviceItem = item as ServiceItem;
    if (serviceItem.title) fields.push(serviceItem.title);
    if (serviceItem.description) fields.push(serviceItem.description);

    if (entry.card.resolvedService) {
      fields.push(entry.card.resolvedService.name, entry.card.resolvedService.purpose);
    } else {
      fields.push(serviceItem.name);
    }
  } else if (item.type === "link") {
    const linkItem = item as LinkItem;
    fields.push(linkItem.title);
    if (linkItem.description) fields.push(linkItem.description);
  }

  return fields.map((field) => field.toLowerCase());
}

/**
 * How the shared `applyFilters` reads a portal card: the query matches the
 * item, resolved-service and group text; `status` is the live bucket (static,
 * not-found and broken cards have none, so they never match a status filter);
 * `group` is the top-level group id.
 */
export const PORTAL_FILTER_ACCESSORS: FilterAccessors<IndexedCard, PortalFacet> = {
  text: cardSearchFields,
  facets: {
    status: (entry) => statusBucket(entry.card.status),
    group: (entry) => entry.groupId,
  },
};
