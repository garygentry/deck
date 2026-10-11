import { referenceTargets, type ComposedReference } from "../../compose/compose.js";
import { finding, type Finding } from "../../findings.js";
import type { DeckConfigDocument } from "../../types.js";
import { serviceKey, type Context } from "../context.js";

/**
 * Check every config host/service reference against the per-call index: the kernel's own,
 * plus those modules declare (`moduleReferences`).
 */
export function references(doc: DeckConfigDocument, ctx: Context, moduleReferences: readonly ComposedReference[] = []): Finding[] {
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
  for (const [index, source] of (doc.sources ?? []).entries()) {
    if (source.owner === undefined) continue;
    const path = `/sources/${index}/owner`;
    if (source.owner.service !== undefined) {
      service(source.owner.host, source.owner.service, `${path}/service`);
    } else {
      host(source.owner.host, `${path}/host`);
    }
  }
  for (const reference of moduleReferences) {
    for (const target of referenceTargets(doc, reference)) {
      if (target.service !== undefined) service(target.host, target.service, target.path);
      else host(target.host, target.path);
    }
  }

  return findings;
}
