import { finding, type Finding } from "../../findings.js";
import { IDENTITY, resolveOwner } from "../../ownership.js";
import type { DeckConfigDocument, JsonObject, ValidateLayer } from "../../types.js";
import { serviceKey, type Context } from "../context.js";

const IDENTITY_LEAVES = identityLeaves();

/** Validate authored-layer ownership and overlay references into a supplied base. */
export function layers(
  doc: DeckConfigDocument,
  _ctx: Context,
  layer: ValidateLayer,
  base?: unknown,
): Finding[] {
  if (layer === "merged") return [];

  const findings: Finding[] = [];
  walkLeaves(doc as unknown as JsonObject, "", "", (ownerPath, pointer) => {
    const owner = resolveOwner(ownerPath);
    if (owner === "both" || owner === "container") return;
    if (layer === "base" && owner === "overlay") {
      findings.push(finding(
        "LAYER_OVERLAY_KEY_IN_BASE",
        pointer,
        `overlay-owned value is present in the base layer at ${pointer}`,
        "Move the presentation value to the overlay layer.",
      ));
    }
    if (layer === "overlay" && owner === "base" && !IDENTITY_LEAVES.has(ownerPath)) {
      findings.push(finding(
        "LAYER_BASE_KEY_IN_OVERLAY",
        pointer,
        `base-owned value is present in the overlay layer at ${pointer}`,
        "Move the inventory value to the base layer.",
      ));
    }
  });

  if (layer === "overlay" && isObject(base)) {
    findings.push(...danglingReferences(doc, base));
  }
  return findings;
}

function danglingReferences(doc: DeckConfigDocument, base: JsonObject): Finding[] {
  const findings: Finding[] = [];
  const baseHosts = new Set<string>();
  const baseServices = new Set<string>();
  if (Array.isArray(base.hosts)) {
    for (const value of base.hosts) {
      if (isObject(value) && typeof value.name === "string") baseHosts.add(value.name);
    }
  }
  if (Array.isArray(base.services)) {
    for (const value of base.services) {
      if (isObject(value) && typeof value.host === "string" && typeof value.name === "string") {
        baseServices.add(serviceKey(value.host, value.name));
      }
    }
  }
  const add = (path: string): void => {
    findings.push(finding(
      "OVERLAY_DANGLING_REF",
      path,
      `overlay reference at ${path} does not resolve against the base layer`,
      "Correct the reference or declare its target in the base layer.",
    ));
  };
  const host = (name: string, path: string): void => {
    if (!baseHosts.has(name)) add(path);
  };
  const service = (hostName: string, name: string, path: string): void => {
    if (!baseServices.has(serviceKey(hostName, name))) add(path);
  };

  for (const [index, value] of (doc.hosts ?? []).entries()) {
    if (!baseHosts.has(value.name)) add(`/hosts/${index}`);
    if (value.hypervisor !== undefined) host(value.hypervisor, `/hosts/${index}/hypervisor`);
  }
  for (const [index, value] of (doc.services ?? []).entries()) {
    if (!baseServices.has(serviceKey(value.host, value.name))) add(`/services/${index}`);
    host(value.host, `/services/${index}/host`);
  }
  for (const [groupIndex, group] of (doc.groups ?? []).entries()) {
    for (const [itemIndex, item] of group.items.entries()) {
      const path = `/groups/${groupIndex}/items/${itemIndex}`;
      if (item.type === "service") service(item.host, item.name, path);
      if (item.type === "group") {
        for (const [childIndex, child] of item.items.entries()) {
          if (child.type === "service") service(child.host, child.name, `${path}/items/${childIndex}`);
        }
      }
    }
  }
  for (const [index, source] of (doc.sources ?? []).entries()) {
    if (source.owner === undefined) continue;
    const path = `/sources/${index}/owner`;
    if (source.owner.service !== undefined) service(source.owner.host, source.owner.service, `${path}/service`);
    else host(source.owner.host, `${path}/host`);
  }
  for (const [index, action] of (doc.actions ?? []).entries()) {
    if (action.target === undefined) continue;
    const path = `/actions/${index}/target`;
    if (action.target.service !== undefined) service(action.target.host, action.target.service, `${path}/service`);
    else host(action.target.host, `${path}/host`);
  }
  return findings;
}

function walkLeaves(
  value: unknown,
  ownerPath: string,
  pointer: string,
  visit: (ownerPath: string, pointer: string) => void,
): void {
  if (Array.isArray(value)) {
    if (value.length === 0) visit(ownerPath, pointer);
    value.forEach((child, index) => walkLeaves(child, `${ownerPath}[]`, `${pointer}/${index}`, visit));
    return;
  }
  if (isObject(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0 && ownerPath !== "") visit(ownerPath, pointer);
    for (const [key, child] of entries) {
      const childOwnerPath = ownerPath === "" ? key : `${ownerPath}.${key}`;
      walkLeaves(child, childOwnerPath, `${pointer}/${escapePointer(key)}`, visit);
    }
    return;
  }
  visit(ownerPath, pointer);
}

function identityLeaves(): ReadonlySet<string> {
  const paths = new Set<string>();
  for (const [arrayPath, spec] of Object.entries(IDENTITY)) {
    if (Array.isArray(spec)) {
      for (const key of spec) paths.add(`${arrayPath}[].${key}`);
    } else {
      for (const keys of Object.values(spec)) {
        for (const key of keys) paths.add(`${arrayPath}[].${key}`);
      }
    }
  }
  return paths;
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function escapePointer(key: string): string {
  return key.replaceAll("~", "~0").replaceAll("/", "~1");
}
