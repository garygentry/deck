import type {
  DeckConfigDocument,
  Host,
  Service,
} from "../types.js";

export interface Located<T = string> {
  key: T;
  path: string;
}

export interface Context {
  hosts: ReadonlyMap<string, Host>;
  services: ReadonlyMap<string, Service>;
  hostOccurrences: readonly Located[];
  serviceOccurrences: readonly Located[];
  idOccurrences: {
    groups: readonly Located[];
    sources: readonly Located[];
    integrations: readonly Located[];
    actions: readonly Located[];
    agents: readonly Located[];
  };
}

export function serviceKey(host: string, name: string): string {
  return `${host}\0${name}`;
}

function collectIds<T extends { id: string }>(
  values: readonly T[] | undefined,
  collection: string,
): Located[] {
  return (values ?? []).map((value, index) => ({
    key: value.id,
    path: `/${collection}/${index}`,
  }));
}

function collectGroupIds(doc: DeckConfigDocument): Located[] {
  const ids: Located[] = [];
  for (const [groupIndex, group] of (doc.groups ?? []).entries()) {
    ids.push({ key: group.id, path: `/groups/${groupIndex}` });
    for (const [itemIndex, item] of group.items.entries()) {
      if (item.type === "group") {
        ids.push({
          key: item.id,
          path: `/groups/${groupIndex}/items/${itemIndex}`,
        });
      }
    }
  }
  return ids;
}

export function buildContext(doc: DeckConfigDocument): Context {
  const hosts = new Map<string, Host>();
  const services = new Map<string, Service>();
  const hostOccurrences: Located[] = [];
  const serviceOccurrences: Located[] = [];

  for (const [index, host] of (doc.hosts ?? []).entries()) {
    hostOccurrences.push({ key: host.name, path: `/hosts/${index}` });
    if (!hosts.has(host.name)) hosts.set(host.name, host);
  }

  for (const [index, service] of (doc.services ?? []).entries()) {
    const key = serviceKey(service.host, service.name);
    serviceOccurrences.push({ key, path: `/services/${index}` });
    if (!services.has(key)) services.set(key, service);
  }

  return {
    hosts,
    services,
    hostOccurrences,
    serviceOccurrences,
    idOccurrences: {
      groups: collectGroupIds(doc),
      sources: collectIds(doc.sources, "sources"),
      integrations: collectIds(doc.integrations, "integrations"),
      actions: collectIds(doc.actions, "actions"),
      agents: collectIds(doc.agents, "agents"),
    },
  };
}
