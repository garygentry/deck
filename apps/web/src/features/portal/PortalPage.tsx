import type {
  Group,
  GroupItem,
  Host,
  Link,
  Service,
  ServiceItem,
  Subgroup,
} from "@deck/schema";
import type { DeckConfig, FreshnessStamp } from "@deck/server";
import { useMemo, useRef, type FunctionComponent, type JSX, type ReactNode } from "react";
import {
  ActiveFilters,
  CardGrid,
  EmptyState,
  FacetFilter,
  FilterBar,
  Icon,
  LoadingState,
  PageHeader,
  ResultCount,
  SearchInput,
  Section,
  describeActiveFilters,
  facetCounts,
  useFacetFilters,
  useListNavigation,
  usePageHeadingId,
  type FacetOption,
} from "@/ui";
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
import { getCards } from "../../registry/registry.js";
import { PORTAL_SUMMARY_SLOT } from "../../shell/portal-summary-slot.js";
import { PortalDataContext, usePortalData } from "./usePortalData.js";

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

export function resolveTarget(item: GroupItem, resolvedService?: Service): string | undefined {
  if (item.type === "link") return item.href;
  if (item.type === "service") {
    const links = (resolvedService?.links ?? []) as Link[];
    return links[0]?.href;
  }
  return undefined;
}

function cardFreshness(
  status: CardViewModel["status"],
  service: Service | undefined,
  data: PortalData,
): FreshnessStamp {
  if (status === "static" || status === "broken-reference" || service === undefined) {
    return STATIC_STAMP;
  }
  const binding = resolveServiceBinding(service);
  if (binding?.kind === "docker") return data.docker?.freshness ?? PENDING_STAMP;
  if (binding?.kind === "gatus") return data.gatus?.freshness ?? PENDING_STAMP;
  return STATIC_STAMP;
}

function buildCards(data: PortalData): IndexedCard[] {
  if (data.config === null) return [];
  const serviceMap = buildServiceMap(data.config);
  const hidden = buildHiddenSets(data.config);
  const cards: IndexedCard[] = [];

  const addCard = (item: CardItem, group: Group): void => {
    if (item.type === "service" && isHiddenServiceItem(item, hidden)) return;
    const service = item.type === "service"
      ? serviceMap.get(`${item.host}/${item.name}`)
      : undefined;
    const status = deriveCardStatus(item, service, { docker: data.docker, gatus: data.gatus });
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

  for (const group of orderedGroups(data.config.groups ?? [])) {
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

function PortalGroup({ group, cards }: { group: Group; cards: readonly IndexedCard[] }): JSX.Element {
  const byItem = new Map(cards.map(({ card }) => [card.item, card]));
  const blocks = groupBlocks(group, byItem);
  return (
    <Section
      title={titleWithIcon(group.title, group.icon)}
      headingId={`group-${group.id}`}
      className="gap-4"
    >
      {blocks.length === 0
        ? <EmptyState compact title="No visible items." />
        : blocks.map((block) => block.kind === "cards"
          ? <CardGrid key={block.key} aria-label={`${group.title} items`}>{renderCards(block.cards)}</CardGrid>
          : (
            <CardGrid
              key={block.key}
              id={block.key}
              heading={titleWithIcon(block.subgroup.title, block.subgroup.icon)}
              level={3}
            >
              {renderCards(block.cards)}
            </CardGrid>
          ))}
    </Section>
  );
}

export const PortalPage: FunctionComponent = () => {
  const data = usePortalData();
  const headingId = usePageHeadingId("Portal");
  const rootRef = useRef<HTMLElement>(null);
  const filters = useFacetFilters<PortalFacet>({ facets: PORTAL_FACETS });
  const indexedCards = useMemo(() => buildCards(data), [data]);
  const result = filters.apply(indexedCards, PORTAL_FILTER_ACCESSORS);
  const groups = data.config === null ? [] : orderedGroups(data.config.groups ?? []);

  useListNavigation({
    keys: "vim",
    // h/l and ←/→ step through the cards. The cards span several group grids,
    // so ↑/↓ also step one card at a time (a single logical column).
    grid: { columns: 1 },
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
    <PortalDataContext.Provider value={data}>
      {/* The health-header region is owned by the shell; its endpoint summary is
          contributed by the self-sufficient EndpointStatusSummary. */}
      <section
        ref={rootRef}
        data-slot="portal-page"
        data-testid="portal"
        aria-labelledby={headingId}
        className="flex flex-col gap-6"
      >
        <PageHeader title="Portal" />
        {/* Summary cards other features contribute (e.g. LLM usage); each renders nothing when it has nothing to say. */}
        {getCards(PORTAL_SUMMARY_SLOT).map(({ id, component: Card }) => (
          <Card key={id} data={null} freshness={STATIC_STAMP} />
        ))}
        <FilterBar
          label="Portal filters"
          search={(
            <SearchInput
              label="Search the portal"
              placeholder="Search the portal"
              shortcut
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
          ? <EmptyState title="No groups configured." />
          : (
            <div className="flex flex-col gap-8">
              {groups.map((group) => (
                <PortalGroup
                  key={group.id}
                  group={group}
                  cards={indexedCards.filter((entry) => entry.groupId === group.id && visibleCards.has(entry))}
                />
              ))}
            </div>
          )}
      </section>
    </PortalDataContext.Provider>
  );
};
