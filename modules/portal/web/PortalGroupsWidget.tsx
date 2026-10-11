import { isSafeHref } from "@deck/module-sdk";
import type { Host, Link, Service } from "@deck/schema";
import type { FreshnessStamp } from "@deck/contract";
import type { DeckConfig } from "@deck/server";
import type { Group, GroupItem, PortalModuleConfig, ServiceItem, Subgroup } from "../server/types.js";
import { useId, useMemo, useRef, type JSX, type ReactNode } from "react";
import {
  ActiveFilters,
  CardGrid,
  EmptyState,
  FacetFilter,
  FilterBar,
  Icon,
  LoadingState,
  ResultCount,
  SearchInput,
  Section,
  describeActiveFilters,
  facetCounts,
  useFacetFilters,
  useListNavigation,
  type FacetOption,
} from "@/ui";
import type { WidgetProps } from "@/registry/registry-types.js";
import {
  deriveCardStatus,
  resolveServiceBinding,
  statusBucket,
  type CardItem,
  type CardViewModel,
  type PortalData,
} from "./card-status.js";
import { CARD_STATUS, PortalCard } from "./PortalCard.js";
import {
  PORTAL_FACETS,
  PORTAL_FILTER_ACCESSORS,
  STATUS_FILTERS,
  type IndexedCard,
  type PortalFacet,
} from "./search-filter.js";
import { usePortalData } from "./usePortalData.js";

const STATIC_STAMP: FreshnessStamp = {
  state: "static",
  observedAt: null,
  ageMs: null,
  ttlMs: null,
};

const PENDING_STAMP: FreshnessStamp = {
  state: "pending",
  observedAt: null,
  ageMs: null,
  ttlMs: null,
};

export interface HiddenSets {
  hosts: Set<string>;
  services: Set<string>;
}

/** The configured portal groups: the portal module's section, which deck validated at boot. */
export function portalGroups(config: DeckConfig): readonly Group[] {
  return (config.modules?.portal as PortalModuleConfig | undefined)?.groups ?? [];
}

export function orderedGroups(groups: readonly Group[]): Group[] {
  return [...groups].sort((a, b) => {
    const order = (a.order ?? Number.MAX_SAFE_INTEGER) -
      (b.order ?? Number.MAX_SAFE_INTEGER);
    return order !== 0 ? order : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

function itemOrder(item: GroupItem): number {
  return item.type === "group"
    ? (item as Subgroup).order ?? Number.MAX_SAFE_INTEGER
    : Number.MAX_SAFE_INTEGER;
}

export function orderedItems(items: readonly GroupItem[]): GroupItem[] {
  return items
    .map((item, index) => ({ item, index, order: itemOrder(item) }))
    .sort((a, b) => a.order !== b.order ? a.order - b.order : a.index - b.index)
    .map(({ item }) => item);
}

export function buildServiceMap(config: DeckConfig): Map<string, Service> {
  const services = new Map<string, Service>();
  for (const service of config.services ?? []) {
    services.set(`${service.host}/${service.name}`, service);
  }
  return services;
}

export function buildHiddenSets(config: DeckConfig): HiddenSets {
  const hosts = new Set<string>();
  for (const host of (config.hosts ?? []) as Host[]) {
    if (host.hidden === true) hosts.add(host.name);
  }
  const services = new Set<string>();
  for (const service of config.services ?? []) {
    if (service.hidden === true) services.add(`${service.host}/${service.name}`);
  }
  return { hosts, services };
}

export function isHiddenServiceItem(item: ServiceItem, hidden: HiddenSets): boolean {
  return hidden.hosts.has(item.host) || hidden.services.has(`${item.host}/${item.name}`);
}

/**
 * A card's link target: a link item's href, or a service's first link. Only an href
 * `isSafeHref` accepts is a target (config validation refuses the rest); any other leaves the
 * card a plain tile, never a `javascript:`, `data:` or `//host` link.
 */
export function resolveTarget(item: GroupItem, resolvedService?: Service): string | undefined {
  let href: string | undefined;
  if (item.type === "link") href = item.href;
  else if (item.type === "service") href = ((resolvedService?.links ?? []) as Link[])[0]?.href;
  return typeof href === "string" && isSafeHref(href) ? href : undefined;
}

function cardFreshness(
  status: CardViewModel["status"],
  service: Service | undefined,
  data: PortalData,
): FreshnessStamp {
  if (status === "static" || status === "broken-reference" || service === undefined) {
    return STATIC_STAMP;
  }
  const binding = resolveServiceBinding(service, data.statusKinds, data.registered);
  if (binding === null) return STATIC_STAMP;
  return data.envelopes.get(binding.providerId)?.freshness ?? PENDING_STAMP;
}

/** The groups a widget shows: every configured group in order, or those its `groups` option names, in that order. */
export function shownGroups(config: DeckConfig, only: readonly string[] | undefined): Group[] {
  const groups = orderedGroups(portalGroups(config));
  if (only === undefined) return groups;
  return only.map((id) => groups.find((group) => group.id === id)).filter((group): group is Group => group !== undefined);
}

function buildCards(data: PortalData, groups: readonly Group[]): IndexedCard[] {
  if (data.config === null) return [];
  const serviceMap = buildServiceMap(data.config);
  const hidden = buildHiddenSets(data.config);
  const cards: IndexedCard[] = [];

  const addCard = (item: CardItem, group: Group): void => {
    if (item.type === "service" && isHiddenServiceItem(item, hidden)) return;
    const service = item.type === "service"
      ? serviceMap.get(`${item.host}/${item.name}`)
      : undefined;
    const status = deriveCardStatus(item, service, data);
    cards.push({
      groupId: group.id,
      groupTitle: group.title,
      card: {
        item,
        resolvedService: service,
        status,
        target: resolveTarget(item, service),
        freshness: cardFreshness(status, service, data),
      },
    });
  };

  for (const group of groups) {
    for (const item of orderedItems(group.items)) {
      if (item.type === "group") {
        for (const child of item.items) addCard(child, group);
      } else {
        addCard(item, group);
      }
    }
  }
  return cards;
}


/** Live bucket → the status map entry that labels it in the Status facet. */
const BUCKET_STATUS = { up: "bound-up", down: "bound-down", unreachable: "unreachable" } as const;

/** The navigable cards: tiles with a target render as links; inert tiles are skipped. */
const CARD_LINK_SELECTOR = 'a[data-slot="link-tile"]';

/** A group's items in configured order, split into runs of direct cards and subgroups. */
type GroupBlock =
  | { kind: "cards"; key: string; cards: CardViewModel[] }
  | { kind: "subgroup"; key: string; subgroup: Subgroup; cards: CardViewModel[] };

function groupBlocks(group: Group, byItem: ReadonlyMap<GroupItem, CardViewModel>): GroupBlock[] {
  const blocks: GroupBlock[] = [];
  for (const [index, item] of orderedItems(group.items).entries()) {
    if (item.type === "group") {
      const cards = item.items
        .map((child) => byItem.get(child))
        .filter((card): card is CardViewModel => card !== undefined);
      if (cards.length > 0) blocks.push({ kind: "subgroup", key: `subgroup-${item.id}`, subgroup: item, cards });
      continue;
    }
    const card = byItem.get(item);
    if (card === undefined) continue;
    const last = blocks.at(-1);
    if (last?.kind === "cards") last.cards.push(card);
    else blocks.push({ kind: "cards", key: `cards-${index}`, cards: [card] });
  }
  return blocks;
}

function titleWithIcon(title: string, icon: string | undefined): ReactNode {
  if (icon === undefined) return title;
  return (
    <span className="flex items-center gap-2">
      <Icon name={icon} className="shrink-0 text-muted-foreground" />
      {title}
    </span>
  );
}

// Card items carry no unique id (links may share an href), so cards are keyed
// by their stable position within their grid.
const renderCards = (cards: readonly CardViewModel[]): JSX.Element[] =>
  cards.map((card, index) => <PortalCard key={index} vm={card} />);

/**
 * Where a widget's groups sit in the page outline and how their DOM ids are namespaced: on the
 * portal page, group `h2` and subgroup `h3` with the page's own `group-<id>` anchors; in a
 * dashboard card (an `h3`), group `h4` and subgroup `h5`, with ids unique to the widget.
 */
interface GroupOutline {
  level: 2 | 4;
  idPrefix: string;
}

function PortalGroup({ group, cards, outline }: { group: Group; cards: readonly IndexedCard[]; outline: GroupOutline }): JSX.Element {
  const byItem = new Map(cards.map(({ card }) => [card.item, card]));
  const blocks = groupBlocks(group, byItem);
  return (
    <Section
      title={titleWithIcon(group.title, group.icon)}
      headingId={`${outline.idPrefix}group-${group.id}`}
      level={outline.level}
      className="gap-4"
    >
      {blocks.length === 0
        ? <EmptyState compact title="No visible items." />
        : blocks.map((block) => block.kind === "cards"
          ? <CardGrid key={block.key} aria-label={`${group.title} items`}>{renderCards(block.cards)}</CardGrid>
          : (
            <CardGrid
              key={block.key}
              id={`${outline.idPrefix}${block.key}`}
              heading={titleWithIcon(block.subgroup.title, block.subgroup.icon)}
              level={outline.level === 2 ? 3 : 5}
            >
              {renderCards(block.cards)}
            </CardGrid>
          ))}
    </Section>
  );
}

/** The `portal/groups` widget's options: the top-level groups it shows (default every group). */
export interface PortalGroupsOptions {
  groups?: string[];
}

/**
 * The portal's cards (`portal/groups`): a filter bar (search, status and group facets with a
 * live result count) over each shown group as a section of card links. On the portal page
 * (`placement: "page"`) it is the page's main list, so its keys (`/`, j/k, Escape) listen on
 * the window; on a dashboard it listens only while focus is inside it.
 */
export function PortalGroupsWidget({ options, placement = "card" }: WidgetProps<PortalGroupsOptions>): JSX.Element {
  const only = options.groups;
  const data = usePortalData(only);
  const rootRef = useRef<HTMLDivElement>(null);
  const instance = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const outline: GroupOutline = placement === "page" ? { level: 2, idPrefix: "" } : { level: 4, idPrefix: `${instance}-` };
  const filters = useFacetFilters<PortalFacet>({ facets: PORTAL_FACETS });
  const groups = useMemo(() => (data.config === null ? [] : shownGroups(data.config, only)), [data.config, only]);
  const indexedCards = useMemo(() => buildCards(data, groups), [data, groups]);
  const result = filters.apply(indexedCards, PORTAL_FILTER_ACCESSORS);

  useListNavigation({
    keys: "vim",
    // h/l and ←/→ step through the cards. The cards span several group grids,
    // so ↑/↓ also step one card at a time (a single logical column).
    grid: { columns: 1 },
    scope: placement === "page" ? "window" : "element",
    containerRef: rootRef,
    getItems: () => rootRef.current?.querySelectorAll<HTMLElement>(CARD_LINK_SELECTOR) ?? [],
    getSearch: () => rootRef.current?.querySelector<HTMLElement>('input[type="search"]') ?? null,
    activateFirstFromSearch: true,
    onEscape: () => {
      if (filters.query === "") return false;
      filters.setQuery("");
    },
  });

  const statusCounts = facetCounts(indexedCards, (entry) => statusBucket(entry.card.status));
  const statusOptions: FacetOption[] = STATUS_FILTERS.map((bucket) => {
    const { icon, label } = CARD_STATUS[BUCKET_STATUS[bucket]];
    return { value: bucket, label, icon, count: statusCounts.get(bucket) ?? 0 };
  });
  const groupCounts = facetCounts(indexedCards, (entry) => entry.groupId);
  const groupOptions: FacetOption[] = groups.map((group) => ({
    value: group.id,
    label: group.title,
    count: groupCounts.get(group.id) ?? 0,
  }));
  const optionLabels: Record<PortalFacet, readonly FacetOption[]> = {
    status: statusOptions,
    group: groupOptions,
  };
  const activeFilters = describeActiveFilters(filters.criteria, {
    valueLabel: (facet, value) =>
      optionLabels[facet].find((option) => option.value === value)?.label ?? value,
  });

  const visibleCards = new Set(result.rows);
  const loading = data.loading && data.config === null;

  return (
    <div ref={rootRef} data-slot="portal-groups" className="flex flex-col gap-6">
      <FilterBar
        label="Portal filters"
        search={(
          <SearchInput
            label="Search the portal"
            placeholder="Search the portal"
            shortcut={placement === "page"}
            value={filters.query}
            onValueChange={filters.setQuery}
          />
        )}
        activeFilters={(
          <ActiveFilters filters={activeFilters} onRemove={filters.remove} onClearAll={filters.clearAll} />
        )}
        resultCount={loading
          ? undefined
          : <ResultCount shown={result.rows.length} total={result.total} noun="items" />}
      >
        <FacetFilter
          title="Status"
          options={statusOptions}
          selected={filters.selected("status")}
          onSelectedChange={(next) => filters.setFacet("status", next)}
        />
        {groupOptions.length > 0 && (
          <FacetFilter
            title="Group"
            options={groupOptions}
            selected={filters.selected("group")}
            onSelectedChange={(next) => filters.setFacet("group", next)}
          />
        )}
      </FilterBar>
      {loading
        ? <LoadingState label="Loading the portal…" preset="cards" />
        : groups.length === 0
        ? <EmptyState title={only === undefined ? "No groups configured." : "None of this widget's groups are configured."} />
        : (
          <div className="flex flex-col gap-8">
            {groups.map((group) => (
              <PortalGroup
                key={group.id}
                group={group}
                outline={outline}
                cards={indexedCards.filter((entry) => entry.groupId === group.id && visibleCards.has(entry))}
              />
            ))}
          </div>
        )}
    </div>
  );
}
