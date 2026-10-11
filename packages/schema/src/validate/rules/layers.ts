import { referenceTargets, type ComposedConfig, type ComposedReference } from "../../compose/compose.js";
import { finding, type Finding } from "../../findings.js";
import { resolveOwner, type IdentitySpec } from "../../ownership.js";
import type { DeckConfigDocument, JsonObject, ValidateLayer } from "../../types.js";
import { serviceKey } from "../context.js";

const identityLeavesCache = new WeakMap<object, ReadonlySet<string>>();

/** Validate authored-layer ownership and overlay references into a supplied base. */
export function layers(
  doc: DeckConfigDocument,
  composed: ComposedConfig,
  layer: ValidateLayer,
  base?: unknown,
  strict = false,
): Finding[] {
  if (layer === "merged") return [];

  const leaves = identityLeaves(composed.identity);
  const findings: Finding[] = [];
  // A disabled module's section is not part of the document deck runs with, so where it
  // sits is not checked (switching a module off must not fail validation), unless disabled
  // sections are validated strictly, as if their modules were on.
  // A module that failed to load is never exempt (its section is checked as if it ran).
  const exempt = strict ? [] : [...composed.disabledModuleIds].filter((id) => !composed.strictModuleIds.has(id)).map((id) => `modules.${id}`);
  walkLeaves(doc as unknown as JsonObject, "", "", (ownerPath, pointer) => {
    if (exempt.some((prefix) => ownerPath === prefix || ownerPath.startsWith(`${prefix}.`) || ownerPath.startsWith(`${prefix}[`))) return;
    const owner = resolveOwner(ownerPath, composed.ownership);
    if (owner === "both" || owner === "container") return;
    if (layer === "base" && owner === "overlay") {
      findings.push(finding(
        "LAYER_OVERLAY_KEY_IN_BASE",
        pointer,
        `overlay-owned value is present in the base layer at ${pointer}`,
        "Move the presentation value to the overlay layer.",
      ));
    }
    if (layer === "overlay" && owner === "base" && !leaves.has(ownerPath)) {
      findings.push(finding(
        "LAYER_BASE_KEY_IN_OVERLAY",
        pointer,
        `base-owned value is present in the overlay layer at ${pointer}`,
        "Move the inventory value to the base layer.",
      ));
    }
  });

  if (layer === "overlay" && isObject(base)) {
    const checked = strict
      ? [...composed.references, ...composed.disabledReferences]
      : [...composed.references, ...composed.disabledReferences.filter((reference) => [...composed.strictModuleIds].some((id) => reference.path.startsWith(`modules.${id}.`)))];
    findings.push(...danglingReferences(doc, base, checked));
  }
  return findings;
}

function danglingReferences(doc: DeckConfigDocument, base: JsonObject, moduleReferences: readonly ComposedReference[]): Finding[] {
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
  for (const [index, source] of (doc.sources ?? []).entries()) {
    if (source.owner === undefined) continue;
    const path = `/sources/${index}/owner`;
    if (source.owner.service !== undefined) service(source.owner.host, source.owner.service, `${path}/service`);
    else host(source.owner.host, `${path}/host`);
  }
  for (const reference of moduleReferences) {
    for (const target of referenceTargets(doc, reference)) {
      if (target.service !== undefined) service(target.host, target.service, target.path);
      else host(target.host, target.path);
    }
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

/** Key paths of identity fields: an overlay restates them to address a base element. */
function identityLeaves(identity: Readonly<Record<string, IdentitySpec>>): ReadonlySet<string> {
  const cached = identityLeavesCache.get(identity);
  if (cached !== undefined) return cached;
  const paths = new Set<string>();
  for (const [arrayPath, spec] of Object.entries(identity)) {
    if (Array.isArray(spec)) {
      for (const key of spec) paths.add(`${arrayPath}[].${key}`);
    } else {
      for (const keys of Object.values(spec as Readonly<Record<string, readonly string[]>>)) {
        for (const key of keys) paths.add(`${arrayPath}[].${key}`);
      }
    }
  }
  identityLeavesCache.set(identity, paths);
  return paths;
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function escapePointer(key: string): string {
  return key.replaceAll("~", "~0").replaceAll("/", "~1");
}
