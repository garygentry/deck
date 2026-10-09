import type { LinkItem, ServiceItem } from "@deck/server/portal";
import type { JSX } from "react";
import { defineStatusMap, FreshnessBadge, LinkTile, StatusBadge } from "@/ui";
import type { CardStatus, CardViewModel } from "./card-status.js";

/** Every card state as tone + icon + text (never colour alone). */
export const CARD_STATUS = defineStatusMap<CardStatus>({
  "bound-up": { tone: "ok", icon: "circle-check", label: "Up" },
  "bound-down": { tone: "danger", icon: "circle-x", label: "Down" },
  unreachable: { tone: "warn", icon: "cloud-off", label: "Unreachable" },
  "not-found": { tone: "warn", icon: "search-x", label: "Not found" },
  "broken-reference": { tone: "danger", icon: "unlink", label: "Broken reference" },
  static: { tone: "neutral", icon: "link", label: "Link" },
  pending: { tone: "pending", icon: "hourglass", label: "Checking" },
});

export interface PortalCardProps {
  vm: CardViewModel;
}

function cardText(vm: CardViewModel): { title: string; description?: string } {
  if (vm.item.type === "link") {
    const item = vm.item as LinkItem;
    return { title: item.title, description: item.description };
  }
  const item = vm.item as ServiceItem;
  return {
    title: item.title ?? vm.resolvedService?.name ?? `${item.host}/${item.name}`,
    description: item.description ?? vm.resolvedService?.purpose,
  };
}

/**
 * One portal item as a whole-card link (or a non-interactive tile when there is
 * no target). The status badge says what the card is; the freshness badge only
 * appears for polled data, so a static link says "Link" once.
 */
export function PortalCard({ vm }: PortalCardProps): JSX.Element {
  const { title, description } = cardText(vm);
  const icon = (vm.item as LinkItem | ServiceItem).icon;
  return (
    <LinkTile
      href={vm.target}
      icon={icon}
      title={title}
      description={description}
      status={StatusBadge.fromMap(CARD_STATUS, vm.status)}
      meta={vm.freshness.state === "static"
        ? undefined
        : <FreshnessBadge freshness={vm.freshness} tooltip={false} />}
    />
  );
}
