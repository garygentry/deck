import { finding, type Finding } from "../../findings.js";
import type { DeckConfigDocument, ServiceItem } from "../../types.js";
import { serviceKey, type Context } from "../context.js";

/** Check every config host/service reference against the per-call index. */
export function references(doc: DeckConfigDocument, ctx: Context): Finding[] {
  const findings: Finding[] = [];

  const host = (name: string, path: string): void => {
    if (!ctx.hosts.has(name)) {
      findings.push(finding(
        "REF_HOST_UNRESOLVED",
        path,
        `host reference at ${path} does not resolve`,
        "Declare the host or correct the referenced name.",
      ));
    }
  };
  const service = (hostName: string, name: string, path: string): void => {
    if (!ctx.services.has(serviceKey(hostName, name))) {
      findings.push(finding(
        "REF_SERVICE_UNRESOLVED",
        path,
        `service reference at ${path} does not resolve`,
        "Declare the service or use a plain link for a non-inventory target.",
      ));
    }
  };

  for (const [index, value] of (doc.services ?? []).entries()) {
    host(value.host, `/services/${index}/host`);
  }
  for (const [index, value] of (doc.hosts ?? []).entries()) {
    if (value.hypervisor !== undefined) host(value.hypervisor, `/hosts/${index}/hypervisor`);
  }
  for (const [groupIndex, group] of (doc.groups ?? []).entries()) {
    for (const [itemIndex, item] of group.items.entries()) {
      const path = `/groups/${groupIndex}/items/${itemIndex}`;
      if (item.type === "service") checkServiceItem(item, path, service);
      if (item.type === "group") {
        for (const [childIndex, child] of item.items.entries()) {
          if (child.type === "service") {
            checkServiceItem(child, `${path}/items/${childIndex}`, service);
          }
        }
      }
    }
  }
  for (const [index, source] of (doc.sources ?? []).entries()) {
    if (source.owner === undefined) continue;
    const path = `/sources/${index}/owner`;
    if (source.owner.service !== undefined) {
      service(source.owner.host, source.owner.service, `${path}/service`);
    } else {
      host(source.owner.host, `${path}/host`);
    }
  }
  for (const [index, action] of (doc.actions ?? []).entries()) {
    if (action.target === undefined) continue;
    const path = `/actions/${index}/target`;
    if (action.target.service !== undefined) {
      service(action.target.host, action.target.service, `${path}/service`);
    } else {
      host(action.target.host, `${path}/host`);
    }
  }

  return findings;
}

function checkServiceItem(
  item: ServiceItem,
  path: string,
  check: (host: string, name: string, path: string) => void,
): void {
  check(item.host, item.name, path);
}
