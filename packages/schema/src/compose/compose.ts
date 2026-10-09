import type { ValidateFunction } from "ajv";

import kernelSchema from "../../schema/deck.schema.json" with { type: "json" };
import {
  FINDING_CATALOG,
  MODULE_HOST_FINDING_CATALOG,
  type Finding,
  type FindingCodeEntry,
} from "../findings.js";
import { IDENTITY, OWNERSHIP, resolveOwner, type IdentitySpec, type Owner } from "../ownership.js";
import type { JsonObject, JsonValue, ValidateLayer } from "../types.js";
import { createAjv, relaxRequired } from "../validate/ajv.js";
import { mapAjvErrors } from "../validate/shape.js";

/** A finding a contributed rule reports, with its path relative to the module's section. */
export interface ContributedFinding {
  code: string;
  path: string;
  message: string;
  hint?: string;
}

/** A pure check over one module's config section. */
export type ContributedRule = (
  section: any,
  context: { layer: ValidateLayer },
) => readonly ContributedFinding[];

/** A provider kind a contribution declares. */
export interface ContributedProviderKind {
  kind: string;
  /** Schema for one instance of this kind in `instanceList`. */
  instanceSchema?: JsonObject;
  instanceList?: "integrations" | "sources";
  /** May appear in `hosts[].bindings` / `services[].bindings`. */
  bindable?: boolean;
  /** Finding codes `validate` may report. */
  findings?: readonly ({ code: string } & FindingCodeEntry)[];
  /** A pure check over one instance; finding paths are relative to the instance. */
  validate?: ContributedInstanceRule;
  /** The fixed provider id the kind's instances register under (a built-in's only). */
  fixedId?: string;
}

/** A pure check over one `integrations[]` / `sources[]` instance of a contributed kind. */
export type ContributedInstanceRule = (
  instance: any,
  context: { layer: ValidateLayer; document: Readonly<JsonObject>; fixedIds: ReadonlyMap<string, string> },
) => readonly ContributedFinding[];

/**
 * What a module contributes to the config contract. A module manifest's `config` and
 * `providerKinds` map onto it field for field; rules come from the server module.
 */
export interface ConfigContribution {
  /** Module id; its section is `modules.<id>`. */
  id: string;
  /**
   * Set when the module is installed but will not run, with the reason. Its section is not
   * part of the strict document (it cannot fail validation, and is exempt from layer
   * ownership checks), and its provider kinds are not known. On the merged document the
   * section is reported as MODULE_SECTION_DISABLED, and any problem its own schema, rules or
   * identities would raise is reported too, at info ("would fail when <id> is enabled").
   */
  disabled?: string;
  /** Schema of the `modules.<id>` section. Absent: the contribution has no section. */
  schema?: JsonObject;
  /** Ownership rows relative to the section (`""` is the section itself; default overlay). */
  ownership?: Readonly<Record<string, Owner>>;
  /**
   * Identity rows for arrays in the section, relative to it. Each is checked for duplicate
   * tuples (ID_DUPLICATE) unless a `unique` namespace covers its array.
   */
  identity?: Readonly<Record<string, IdentitySpec>>;
  /**
   * Id namespaces checked for duplicates (ID_DUPLICATE), each spanning one or more arrays.
   * The identity row of an array a namespace covers only keys the layer merge. When given,
   * the list names at least one namespace.
   */
  unique?: readonly ContributedUnique[];
  /** Finding codes the contribution's rules may emit. */
  findings?: readonly ({ code: string } & FindingCodeEntry)[];
  providerKinds?: readonly ContributedProviderKind[];
  rules?: readonly ContributedRule[];
  /**
   * Where the section names an estate host or service, relative to the section. They are
   * resolved like the kernel's own references (REF_HOST_UNRESOLVED, REF_SERVICE_UNRESOLVED,
   * and OVERLAY_DANGLING_REF against an overlay's base).
   */
  references?: readonly ContributedReference[];
}

/**
 * A host/service reference declaration: a key path (`actions[].target`) whose value is
 * `{ host, service? }`, or an object naming the value's `host` / `service` fields and
 * whether findings point at the field (default) or at the value itself (`element`).
 */
export type ContributedReference =
  | string
  | { path: string; host?: string; service?: string; at?: "field" | "element" };

/** An id namespace over the elements of one or more arrays (key paths ending in `[]`). */
export interface ContributedUnique {
  paths: readonly string[];
  key: readonly string[];
  /** The ID_DUPLICATE message; `{key}` is replaced by the id. */
  message?: string;
}

/** A reference declaration resolved to an absolute key path and its field names. */
export interface ComposedReference {
  /** Absolute key path (`modules.<id>.…`) of the referencing values. */
  path: string;
  host: string;
  service: string;
  at: "field" | "element";
}

/** The config contract composed from the kernel schema and every contribution. */
export interface ComposedConfig {
  /** The strict composed schema (the merged and base documents). */
  readonly schema: JsonObject;
  readonly checkConfig: ValidateFunction;
  /** The relaxed variant for overlay documents. */
  readonly checkOverlay: ValidateFunction;
  readonly ownership: Readonly<Record<string, Owner>>;
  readonly identity: Readonly<Record<string, IdentitySpec>>;
  readonly catalog: Readonly<Record<string, FindingCodeEntry>>;
  readonly knownKinds: ReadonlySet<string>;
  /** Enabled modules' host/service references. */
  readonly references: readonly ComposedReference[];
  /** The same for disabled modules (checked only with `disabledSections: "strict"`). */
  readonly disabledReferences: readonly ComposedReference[];
  /** The known kinds a host or service may bind (PROVIDER_BINDING_UNSUPPORTED otherwise). */
  readonly bindableKinds: ReadonlySet<string>;
  /**
   * Kinds declared only by modules that are known but will not run (switched off or
   * refused), by kind → module id: a reference to one is PROVIDER_KIND_DISABLED, not unknown.
   */
  readonly disabledKinds: ReadonlyMap<string, string>;
  /** Ids of enabled modules with a `modules.<id>` section, sorted. */
  readonly moduleIds: readonly string[];
  /** Every id that may have a `modules.<id>` section (enabled or disabled), sorted. */
  readonly knownModuleIds: readonly string[];
  /** Ids of disabled modules: their sections are exempt from layer ownership checks. */
  readonly disabledModuleIds: ReadonlySet<string>;
  /**
   * The checks composed from contributions, for one validated document:
   * - duplicate identity tuples in module arrays, and duplicate ids in a declared
   *   namespace (ID_DUPLICATE);
   * - each enabled module's rules on its section; a rule that throws or reports an
   *   undeclared code yields MODULE_RULE_FAILED instead of failing the document;
   * - on the merged document, MODULE_SECTION_DISABLED for each disabled module's section,
   *   plus each problem its schema, rules, identities or references would report: at info
   *   ("would fail when enabled") with `disabledSections: "advisory"`, else as reported.
   */
  runChecks(document: JsonObject, layer: ValidateLayer, options?: { disabledSections?: DisabledSections }): Finding[];
}

/**
 * A contribution the kernel cannot compose. `MODULE_MANIFEST_CONFLICT`: two contributions
 * claim the same id, finding code or provider kind. `MODULE_MANIFEST_INVALID`: one
 * contribution is malformed on its own (for example, a schema that does not compile).
 */
export class ComposeError extends Error {
  constructor(
    readonly code: "MODULE_MANIFEST_CONFLICT" | "MODULE_MANIFEST_INVALID",
    readonly moduleId: string,
    reason: string,
  ) {
    super(`module "${moduleId}": ${reason}`);
    this.name = "ComposeError";
  }
}

const CODE_PATTERN = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/;
/** A relative key path: `.`-separated keys, each optionally `[]` (every element of an array). */
const KEY_PATH = /^[^.[\]]+(?:\[\])?(?:\.[^.[\]]+(?:\[\])?)*$/;
const DEFS_REF = /^#\/\$defs\/([^/]+)/;
/** Keywords that would give a contributed schema its own resource or dynamic scope. */
const RESOURCE_KEYWORDS = ["$id", "$anchor", "$dynamicAnchor", "$dynamicRef", "$recursiveAnchor", "$recursiveRef"];

/**
 * The fields every `integrations[]` / `sources[]` instance has, whatever its kind. A kind's
 * instance schema is checked together with this core, never instead of it.
 */
const INSTANCE_CORE: JsonObject = {
  type: "object",
  required: ["id", "kind"],
  properties: {
    id: { type: "string" },
    kind: { type: "string" },
    title: { type: "string" },
    credentialEnv: { type: "string", pattern: "^[A-Z][A-Z0-9_]*$" },
  },
};

/**
 * Compose the config contract (schema, ownership, identity, finding catalog, provider kinds
 * and rules) from the kernel and the given contributions. The root and `modules` stay
 * closed, so an unknown key or module is still rejected. Throws {@link ComposeError}.
 */
export function composeConfig(contributions: readonly ConfigContribution[]): ComposedConfig {
  const schema = structuredClone(kernelSchema) as unknown as KernelSchemaShape;
  const ownership: Record<string, Owner> = { ...OWNERSHIP };
  const identity: Record<string, IdentitySpec> = { ...IDENTITY };
  const catalog: Record<string, FindingCodeEntry> = { ...FINDING_CATALOG, ...MODULE_HOST_FINDING_CATALOG };
  const kindOwners = new Map<string, string>();
  const bindableKinds = new Set<string>();
  const disabledKinds = new Map<string, string>();
  const instanceSchemas: Record<"integrations" | "sources", Array<{ kind: string; schema: JsonObject }>> = {
    integrations: [],
    sources: [],
  };
  const rules: Array<{ id: string; codes: ReadonlySet<string>; rule: ContributedRule }> = [];
  const instanceRules: Array<{ id: string; kind: string; list: "integrations" | "sources"; codes: ReadonlySet<string>; rule: ContributedInstanceRule }> = [];
  const fixedIds = new Map<string, string>();
  const sectionRoots: Array<{ id: string; def: string }> = [];
  const disabled = new Map<string, DisabledSection>();
  const checkedIdentity: Array<[string, IdentitySpec]> = [];
  const namespaces: ComposedUnique[] = [];
  const references: ComposedReference[] = [];
  const moduleIds: string[] = [];
  const seen = new Set<string>();

  for (const contribution of contributions) {
    const { id } = contribution;
    if (seen.has(id)) throw new ComposeError("MODULE_MANIFEST_CONFLICT", id, "duplicate module id");
    seen.add(id);
    const prefix = `modules.${id}`;

    const off = contribution.disabled !== undefined;
    if (off) {
      // Known but not running: its section is accepted as-is in the composed document.
      schema.properties.modules.properties[id] = { description: `Settings of module ${id}, which is not enabled.` };
      ownership[prefix] = "overlay";
      disabled.set(id, { reason: contribution.disabled!, def: undefined, codes: new Set(), rules: [], identity: [], unique: [], references: [] });
    }

    if (contribution.schema !== undefined) {
      const def = `module__${id}`;
      const ref = hoist(contribution.schema, def, schema.$defs, id);
      if (off) disabled.get(id)!.def = def;
      else {
        schema.properties.modules.properties[id] = ref;
        sectionRoots.push({ id, def });
        moduleIds.push(id);
      }
      ownership[prefix] = "overlay";
      for (const [path, owner] of Object.entries(contribution.ownership ?? {})) {
        ownership[path === "" ? prefix : `${prefix}.${path}`] = owner;
      }
    }

    const declaredNamespaces = composeUnique(contribution.unique, id, prefix);
    // An array a namespace covers is checked by the namespace; its identity row only keys the merge.
    const covered = new Set(declaredNamespaces.flatMap(({ paths }) => paths));
    if (contribution.schema !== undefined) {
      for (const [path, spec] of Object.entries(contribution.identity ?? {})) {
        identity[`${prefix}.${path}`] = spec;
        if (covered.has(`${prefix}.${path}[]`)) continue;
        if (off) disabled.get(id)!.identity.push([`${prefix}.${path}`, spec]);
        else checkedIdentity.push([`${prefix}.${path}`, spec]);
      }
    }
    for (const namespace of declaredNamespaces) {
      if (off) disabled.get(id)!.unique.push(namespace);
      else namespaces.push(namespace);
    }
    for (const reference of composeReferences(contribution.references, id, prefix)) {
      if (off) disabled.get(id)!.references.push(reference);
      else references.push(reference);
    }

    const codes = new Set<string>();
    for (const { code, severity, summary, fix } of contribution.findings ?? []) {
      if (!CODE_PATTERN.test(code)) {
        throw new ComposeError("MODULE_MANIFEST_INVALID", id, `finding code "${code}" is not UPPER_SNAKE_CASE`);
      }
      if (Object.prototype.hasOwnProperty.call(catalog, code)) {
        throw new ComposeError("MODULE_MANIFEST_CONFLICT", id, `finding code ${code} is already catalogued`);
      }
      catalog[code] = { severity, summary, fix };
      codes.add(code);
    }

    // A disabled module's kinds are not available; they are recorded so a reference to one
    // names its owner as off (PROVIDER_KIND_DISABLED) instead of reading as unknown.
    if (off) {
      for (const { kind } of contribution.providerKinds ?? []) if (!disabledKinds.has(kind)) disabledKinds.set(kind, id);
    }
    for (const declared of off ? [] : contribution.providerKinds ?? []) {
      const owner = kindOwners.get(declared.kind);
      if (owner !== undefined) {
        throw new ComposeError("MODULE_MANIFEST_CONFLICT", id, `provider kind "${declared.kind}" is already declared by "${owner}"`);
      }
      kindOwners.set(declared.kind, id);
      if (declared.bindable === true) bindableKinds.add(declared.kind);
      const kindCodes = new Set<string>();
      for (const { code, severity, summary, fix } of declared.findings ?? []) {
        if (!CODE_PATTERN.test(code)) {
          throw new ComposeError("MODULE_MANIFEST_INVALID", id, `finding code "${code}" is not UPPER_SNAKE_CASE`);
        }
        if (Object.prototype.hasOwnProperty.call(catalog, code)) {
          throw new ComposeError("MODULE_MANIFEST_CONFLICT", id, `finding code ${code} is already catalogued`);
        }
        catalog[code] = { severity, summary, fix };
        kindCodes.add(code);
      }
      if (declared.fixedId !== undefined) fixedIds.set(declared.kind, declared.fixedId);
      if (declared.validate !== undefined) {
        instanceRules.push({ id, kind: declared.kind, list: declared.instanceList ?? "integrations", codes: kindCodes, rule: declared.validate });
      }
      if (declared.instanceSchema !== undefined) {
        instanceSchemas[declared.instanceList ?? "integrations"].push({
          kind: declared.kind,
          schema: hoist(declared.instanceSchema, `kind__${declared.kind}`, schema.$defs, id),
        });
      }
    }

    for (const rule of contribution.rules ?? []) {
      if (off) disabled.get(id)!.rules.push(rule);
      else rules.push({ id, codes, rule });
    }
    if (off) disabled.get(id)!.codes = codes;
  }

  // An instance of a declared kind must match that kind's schema as well as the instance
  // core. Any other kind falls through to the generic shape, so an unknown kind stays a
  // PROVIDER_KIND_UNKNOWN warning rather than a shape error.
  for (const list of ["integrations", "sources"] as const) {
    const generic: JsonObject = { $ref: list === "integrations" ? "#/$defs/Integration" : "#/$defs/Source" };
    schema.properties[list].items = instanceSchemas[list].reduceRight<JsonObject>(
      (otherwise, { kind, schema: instance }) => ({
        if: { type: "object", properties: { kind: { const: kind } }, required: ["kind"] },
        then: { allOf: [INSTANCE_CORE, instance] },
        else: otherwise,
      }),
      generic,
    );
  }

  const leaves = identityLeaves(identity);
  const relaxed = relaxRequired(schema);
  relaxBaseOwned(relaxed, sectionRoots, ownership, leaves);

  let checkConfig: ValidateFunction;
  let checkOverlay: ValidateFunction;
  try {
    checkConfig = createAjv().compile(schema);
    checkOverlay = createAjv().compile(relaxed);
  } catch (cause) {
    throw new ComposeError(
      "MODULE_MANIFEST_INVALID",
      contributions.map((c) => c.id).join(", ") || "kernel",
      `config schema does not compile: ${(cause as Error).message}`,
    );
  }

  // A disabled module's section is checked on its own, so its problems can be reported
  // without failing the document.
  const disabledChecks = new Map<string, ValidateFunction>();
  for (const [id, section] of disabled) {
    if (section.def === undefined) continue;
    try {
      disabledChecks.set(id, createAjv().compile({ $defs: schema.$defs, $ref: `#/$defs/${escapePointer(section.def)}` }));
    } catch (cause) {
      throw new ComposeError("MODULE_MANIFEST_INVALID", id, `config schema does not compile: ${(cause as Error).message}`);
    }
  }

  const catalogued = Object.freeze(catalog);

  const moduleFinding = (code: "MODULE_RULE_FAILED" | "MODULE_SECTION_DISABLED", id: string, message: string): Finding => ({
    code,
    severity: catalogued[code]!.severity,
    path: `/modules/${escapePointer(id)}`,
    message,
  });

  return Object.freeze({
    schema: schema as unknown as JsonObject,
    checkConfig,
    checkOverlay,
    ownership: Object.freeze(ownership),
    identity: Object.freeze(identity),
    catalog: catalogued,
    knownKinds: new Set(kindOwners.keys()),
    references: Object.freeze(references),
    disabledReferences: Object.freeze([...disabled.values()].flatMap((section) => section.references)),
    bindableKinds,
    // A kind an enabled contribution declares is known, even if an off module declares it too.
    disabledKinds: new Map([...disabledKinds].filter(([kind]) => !kindOwners.has(kind))),
    moduleIds: Object.freeze([...moduleIds].sort()),
    knownModuleIds: Object.freeze([...moduleIds, ...disabled.keys()].sort()),
    disabledModuleIds: new Set(disabled.keys()),
    runChecks(document: JsonObject, layer: ValidateLayer, options: { disabledSections?: DisabledSections } = {}): Finding[] {
      const advisory = (options.disabledSections ?? "advisory") === "advisory";
      const sections = isObject(document.modules) ? document.modules : {};
      const findings: Finding[] = [...duplicateIdentities(document, checkedIdentity), ...duplicateIds(document, namespaces)];
      // Strictly, a disabled section's duplicates are checked in each authored layer too, as an
      // enabled module's are: a merge pairs elements by identity and would hide them.
      if (!advisory && layer !== "merged") {
        for (const [id, section] of disabled) {
          if (!Object.prototype.hasOwnProperty.call(sections, id)) continue;
          findings.push(...duplicateIdentities(document, section.identity), ...duplicateIds(document, section.unique));
        }
      }
      for (const { id, codes, rule } of rules) {
        if (!Object.prototype.hasOwnProperty.call(sections, id)) continue;
        let reported: readonly ContributedFinding[];
        try {
          reported = rule(sections[id], { layer });
          if (!Array.isArray(reported)) throw new Error("did not return a list of findings");
        } catch (error) {
          findings.push(moduleFinding("MODULE_RULE_FAILED", id, `A config rule of module "${id}" failed: ${(error as Error)?.message ?? String(error)}`));
          continue;
        }
        for (const item of reported) {
          if (!codes.has(item.code)) {
            findings.push(moduleFinding("MODULE_RULE_FAILED", id, `A config rule of module "${id}" reported ${String(item.code)}, which its manifest does not declare.`));
            continue;
          }
          findings.push({
            code: item.code,
            severity: catalogued[item.code]!.severity,
            path: `/modules/${escapePointer(id)}${item.path}`,
            message: item.message,
            ...(item.hint ? { hint: item.hint } : {}),
          });
        }
      }
      if (layer === "merged") findings.push(...instanceFindings(document, layer, instanceRules, catalogued, moduleFinding, fixedIds));
      if (layer === "merged") {
        for (const [id, section] of disabled) {
          if (!Object.prototype.hasOwnProperty.call(sections, id)) continue;
          findings.push(moduleFinding("MODULE_SECTION_DISABLED", id, `modules.${id} is set, but module "${id}" is not enabled (${section.reason}); the section is ignored.`));
          // What enabling the module would report, so a disabled section is still checked:
          // advisory, at info; strict, exactly as reported (an error fails validation).
          const wouldFail = (item: Finding): Finding => (advisory
            ? {
              code: "MODULE_SECTION_DISABLED",
              severity: catalogued.MODULE_SECTION_DISABLED!.severity,
              path: item.path,
              message: `would fail when "${id}" is enabled: ${item.code} ${item.message}`,
            }
            : item);
          const prefix = `/modules/${escapePointer(id)}`;
          const check = disabledChecks.get(id);
          if (check !== undefined && !check(sections[id])) {
            const shaped = mapAjvErrors(check.errors, "merged").map((item) => ({ ...item, path: `${prefix}${item.path}` }));
            findings.push(...shaped.map(wouldFail));
            continue;
          }
          findings.push(...duplicateIdentities(document, section.identity).map(wouldFail));
          findings.push(...duplicateIds(document, section.unique).map(wouldFail));
          findings.push(...unresolvedReferences(document, section.references).map(wouldFail));
          for (const rule of section.rules) {
            try {
              for (const item of rule(sections[id], { layer })) {
                const known = section.codes.has(item.code);
                const code = known ? item.code : "MODULE_RULE_FAILED";
                findings.push(wouldFail({
                  code,
                  severity: catalogued[code]!.severity,
                  path: `${prefix}${item.path}`,
                  message: known ? item.message : `reported ${String(item.code)}, which the manifest does not declare`,
                  ...(known && item.hint ? { hint: item.hint } : {}),
                }));
              }
            } catch (error) {
              findings.push(wouldFail({ code: "MODULE_RULE_FAILED", severity: catalogued.MODULE_RULE_FAILED!.severity, path: prefix, message: `a config rule threw: ${(error as Error)?.message ?? String(error)}` }));
            }
          }
        }
      }
      return findings;
    },
  });
}

/**
 * Run each kind's instance rule over the instances of that kind, in document order. A rule that
 * throws, or reports a code its kind does not declare, is MODULE_RULE_FAILED.
 */
function instanceFindings(
  document: JsonObject,
  layer: ValidateLayer,
  instanceRules: ReadonlyArray<{ id: string; kind: string; list: "integrations" | "sources"; codes: ReadonlySet<string>; rule: ContributedInstanceRule }>,
  catalogued: Readonly<Record<string, FindingCodeEntry>>,
  moduleFinding: (code: "MODULE_RULE_FAILED", id: string, message: string) => Finding,
  fixedIds: ReadonlyMap<string, string>,
): Finding[] {
  const findings: Finding[] = [];
  for (const { id, kind, list, codes, rule } of instanceRules) {
    const instances = document[list];
    if (!Array.isArray(instances)) continue;
    instances.forEach((instance, index) => {
      if (!isObject(instance) || instance.kind !== kind) return;
      const prefix = `/${list}/${index}`;
      let reported: readonly ContributedFinding[];
      try {
        reported = rule(instance, { layer, document, fixedIds });
        if (!Array.isArray(reported)) throw new Error("did not return a list of findings");
      } catch (error) {
        // The path names the instance, not the module, so the module is carried explicitly.
        findings.push({ ...moduleFinding("MODULE_RULE_FAILED", id, `A config rule of module "${id}" for kind "${kind}" failed: ${(error as Error)?.message ?? String(error)}`), path: prefix, module: id });
        return;
      }
      for (const item of reported) {
        if (!codes.has(item.code)) {
          findings.push({ ...moduleFinding("MODULE_RULE_FAILED", id, `A config rule of module "${id}" reported ${String(item.code)}, which its kind "${kind}" does not declare.`), path: prefix, module: id });
          continue;
        }
        findings.push({
          code: item.code,
          severity: catalogued[item.code]!.severity,
          path: `${prefix}${item.path}`,
          message: item.message,
          ...(item.hint ? { hint: item.hint } : {}),
        });
      }
    });
  }
  return findings;
}

/** A disabled module's section: why it is off, and what it would be checked against if on. */
interface DisabledSection {
  reason: string;
  /** The hoisted section schema, when the module contributes one that composes. */
  def: string | undefined;
  codes: ReadonlySet<string>;
  rules: ContributedRule[];
  identity: Array<[string, IdentitySpec]>;
  unique: ComposedUnique[];
  references: ComposedReference[];
}

/** A declared id namespace with absolute key paths. */
interface ComposedUnique {
  paths: readonly string[];
  key: readonly string[];
  message: string | undefined;
}

/** Validate and resolve a contribution's reference declarations. Throws MODULE_MANIFEST_INVALID. */
function composeReferences(declared: unknown, id: string, prefix: string): ComposedReference[] {
  if (declared === undefined) return [];
  if (!Array.isArray(declared)) throw new ComposeError("MODULE_MANIFEST_INVALID", id, "references must be a list");
  return declared.map((entry: unknown): ComposedReference => {
    if (typeof entry === "string") {
      if (!KEY_PATH.test(entry)) {
        throw new ComposeError("MODULE_MANIFEST_INVALID", id, `reference "${entry}" is not a key path such as actions[].target`);
      }
      return { path: `${prefix}.${entry}`, host: "host", service: "service", at: "field" };
    }
    const shown = JSON.stringify(entry) ?? String(entry);
    if (!isObject(entry)) {
      throw new ComposeError("MODULE_MANIFEST_INVALID", id, `reference ${shown} is neither a key path nor an object`);
    }
    const extra = Object.keys(entry).find((key) => !["path", "host", "service", "at"].includes(key));
    if (extra !== undefined) throw new ComposeError("MODULE_MANIFEST_INVALID", id, `reference ${shown} has unknown field "${extra}"`);
    const { path, host = "host", service = "service", at = "field" } = entry;
    if (typeof path !== "string" || !KEY_PATH.test(path)) {
      throw new ComposeError("MODULE_MANIFEST_INVALID", id, `reference ${shown} needs a path that is a key path such as actions[].target`);
    }
    for (const [name, field] of [["host", host], ["service", service]] as const) {
      if (typeof field !== "string" || field === "") {
        throw new ComposeError("MODULE_MANIFEST_INVALID", id, `reference ${shown}: ${name} must be a non-empty field name`);
      }
    }
    if (host === service) throw new ComposeError("MODULE_MANIFEST_INVALID", id, `reference ${shown}: host and service name the same field`);
    if (at !== "field" && at !== "element") {
      throw new ComposeError("MODULE_MANIFEST_INVALID", id, `reference ${shown}: at must be "field" or "element"`);
    }
    return { path: `${prefix}.${path}`, host: host as string, service: service as string, at };
  });
}

/** Validate and resolve a contribution's id namespaces. Throws MODULE_MANIFEST_INVALID. */
function composeUnique(declared: unknown, id: string, prefix: string): ComposedUnique[] {
  if (declared === undefined) return [];
  if (!Array.isArray(declared)) throw new ComposeError("MODULE_MANIFEST_INVALID", id, "unique must be a list");
  if (declared.length === 0) throw new ComposeError("MODULE_MANIFEST_INVALID", id, "unique must name at least one namespace");
  return declared.map((entry: unknown): ComposedUnique => {
    const shown = JSON.stringify(entry) ?? String(entry);
    if (!isObject(entry)) throw new ComposeError("MODULE_MANIFEST_INVALID", id, `unique entry ${shown} is not an object`);
    const extra = Object.keys(entry).find((key) => !["paths", "key", "message"].includes(key));
    if (extra !== undefined) throw new ComposeError("MODULE_MANIFEST_INVALID", id, `unique entry ${shown} has unknown field "${extra}"`);
    const { paths, key, message } = entry;
    if (!Array.isArray(paths) || paths.length === 0 || !paths.every((path) => typeof path === "string" && KEY_PATH.test(path) && path.endsWith("[]"))) {
      throw new ComposeError("MODULE_MANIFEST_INVALID", id, `unique entry ${shown}: paths must be a non-empty list of key paths ending in [] such as items[]`);
    }
    if (new Set(paths).size !== paths.length) throw new ComposeError("MODULE_MANIFEST_INVALID", id, `unique entry ${shown} lists a path twice`);
    if (!Array.isArray(key) || key.length === 0 || !key.every((field) => typeof field === "string" && field !== "")) {
      throw new ComposeError("MODULE_MANIFEST_INVALID", id, `unique entry ${shown}: key must be a non-empty list of field names`);
    }
    if (message !== undefined && (typeof message !== "string" || message === "")) {
      throw new ComposeError("MODULE_MANIFEST_INVALID", id, `unique entry ${shown}: message must be a non-empty string`);
    }
    return { paths: (paths as string[]).map((path) => `${prefix}.${path}`), key: key as string[], message: message as string | undefined };
  });
}

interface KernelSchemaShape {
  properties: {
    modules: { properties: Record<string, JsonObject> };
    integrations: { items: JsonObject };
    sources: { items: JsonObject };
  };
  $defs: Record<string, JsonValue>;
}

/**
 * Add a contributed schema to the composed `$defs` as `def`, and return a reference to it.
 * Its local references (`#`, `#/properties/…`, `#/$defs/<own>…`, `#/definitions/…`) are
 * rebased onto `def`, so they keep pointing into the contributed schema. A `#/$defs/<name>`
 * whose name the schema does not define itself refers to a kernel definition and is kept.
 * A schema that declares its own resource or dynamic scope, or references outside the
 * document, is refused.
 */
function hoist(contributed: JsonObject, def: string, defs: Record<string, JsonValue>, moduleId: string): JsonObject {
  const { $schema: _dialect, ...root } = structuredClone(contributed) as JsonObject;
  const local = new Set(Object.keys(isObject(root.$defs) ? root.$defs : {}));
  const base = `#/$defs/${escapePointer(def)}`;
  const rewrite = (value: JsonValue): JsonValue => {
    if (Array.isArray(value)) return value.map(rewrite);
    if (!isObject(value)) return value;
    const output: JsonObject = {};
    for (const [key, child] of Object.entries(value)) {
      if (RESOURCE_KEYWORDS.includes(key)) {
        throw new ComposeError("MODULE_MANIFEST_INVALID", moduleId, `config schema uses ${key}, which a contributed schema may not declare`);
      }
      if (key === "$ref" && typeof child === "string") {
        if (!child.startsWith("#")) {
          throw new ComposeError("MODULE_MANIFEST_INVALID", moduleId, `config schema references "${child}" outside itself`);
        }
        const kernelDef = DEFS_REF.exec(child);
        output[key] = kernelDef !== null && !local.has(unescapePointer(kernelDef[1]!)) ? child : `${base}${child.slice(1)}`;
        continue;
      }
      output[key] = rewrite(child);
    }
    return output;
  };
  defs[def] = rewrite(root);
  return { $ref: base };
}

/**
 * In the overlay variant, drop `required` fields of module sections that the base layer
 * owns: an overlay addresses an element by its identity fields and may not restate
 * base-owned values. A field stays required where any path reaching the schema keeps it.
 */
function relaxBaseOwned(
  relaxed: KernelSchemaShape,
  sectionRoots: ReadonlyArray<{ id: string; def: string }>,
  ownership: Readonly<Record<string, Owner>>,
  leaves: ReadonlySet<string>,
): void {
  const droppable = new Map<JsonObject, Map<string, boolean>>();
  const visit = (node: JsonValue | undefined, path: string, stack: Set<JsonObject>): void => {
    if (!isObject(node)) return;
    if (typeof node.$ref === "string" && /^#\/\$defs\/(module|kind)__/.test(node.$ref)) {
      const target = resolveLocal(relaxed as unknown as JsonObject, node.$ref);
      if (isObject(target) && !stack.has(target)) {
        stack.add(target);
        visit(target, path, stack);
        stack.delete(target);
      }
    }
    if (Array.isArray(node.required)) {
      const fields = droppable.get(node) ?? new Map<string, boolean>();
      droppable.set(node, fields);
      for (const field of node.required) {
        if (typeof field !== "string") continue;
        const fieldPath = `${path}.${field}`;
        const baseOwned = resolveOwner(fieldPath, ownership) === "base" && !leaves.has(fieldPath);
        fields.set(field, (fields.get(field) ?? true) && baseOwned);
      }
    }
    if (isObject(node.properties)) {
      for (const [key, child] of Object.entries(node.properties)) visit(child, `${path}.${key}`, stack);
    }
    visit(node.items, `${path}[]`, stack);
    for (const keyword of ["allOf", "anyOf", "oneOf"]) {
      const branches = node[keyword];
      if (Array.isArray(branches)) for (const branch of branches) visit(branch, path, stack);
    }
    visit(node.then, path, stack);
    visit(node.else, path, stack);
  };
  for (const { id, def } of sectionRoots) {
    const root = relaxed.$defs[def];
    if (isObject(root)) visit(root, `modules.${id}`, new Set([root]));
  }
  for (const [node, fields] of droppable) {
    node.required = (node.required as string[]).filter((field) => !fields.get(field));
  }
}

/** Duplicate identity tuples in module arrays, which a merge would silently collapse. */
function duplicateIdentities(document: JsonObject, rows: ReadonlyArray<[string, IdentitySpec]>): Finding[] {
  const findings: Finding[] = [];
  for (const [path, spec] of rows) {
    const steps = path.split(".");
    const collection = steps.at(-1)!.replace(/\[\]$/, "");
    for (const { array, pointer } of arraysAt(document, steps, "")) {
      const seenKeys = new Set<string>();
      array.forEach((element, index) => {
        if (!isObject(element)) return;
        const fixed = Array.isArray(spec);
        const type = typeof element.type === "string" ? element.type : undefined;
        const keys = fixed ? (spec as readonly string[]) : type === undefined ? undefined : (spec as Record<string, readonly string[]>)[type];
        if (keys === undefined || keys.some((key) => !Object.prototype.hasOwnProperty.call(element, key))) return;
        const values = keys.map((key) => element[key]);
        const tuple = JSON.stringify(fixed ? values : [type, ...values]);
        if (!seenKeys.has(tuple)) {
          seenKeys.add(tuple);
          return;
        }
        const shown = values.length === 1 ? JSON.stringify(values[0]) : `(${values.map((value) => JSON.stringify(value)).join(", ")})`;
        findings.push({
          code: "ID_DUPLICATE",
          severity: FINDING_CATALOG.ID_DUPLICATE.severity,
          path: `${pointer}/${index}`,
          message: `${fixed ? "Id" : `A ${type} with identity`} ${shown} is used more than once within ${collection}.`,
        });
      });
    }
  }
  return findings;
}

/**
 * Duplicate ids in declared namespaces: every element with all the key fields, across the
 * namespace's arrays, in document order; each later occurrence of an id is reported.
 */
function duplicateIds(document: JsonObject, namespaces: readonly ComposedUnique[]): Finding[] {
  const findings: Finding[] = [];
  for (const { paths, key, message } of namespaces) {
    const occurrences: Array<{ values: JsonValue[]; pointer: string }> = [];
    for (const path of paths) {
      for (const { array, pointer } of arraysAt(document, path.slice(0, -2).split("."), "")) {
        array.forEach((element, index) => {
          if (isObject(element) && key.every((field) => Object.prototype.hasOwnProperty.call(element, field))) {
            occurrences.push({ values: key.map((field) => element[field]!), pointer: `${pointer}/${index}` });
          }
        });
      }
    }
    occurrences.sort((a, b) => comparePointers(a.pointer, b.pointer));
    const seen = new Set<string>();
    for (const { values, pointer } of occurrences) {
      const tuple = JSON.stringify(values);
      if (!seen.has(tuple)) {
        seen.add(tuple);
        continue;
      }
      const shown = values.length === 1 ? JSON.stringify(values[0]) : `(${values.map((value) => JSON.stringify(value)).join(", ")})`;
      findings.push({
        code: "ID_DUPLICATE",
        severity: FINDING_CATALOG.ID_DUPLICATE.severity,
        path: pointer,
        message: message === undefined ? `Id ${shown} is used more than once.` : message.replaceAll("{key}", () => shown),
      });
    }
  }
  return findings;
}

/** Document order of two pointers: an ancestor first, array indexes numerically. */
function comparePointers(a: string, b: string): number {
  const left = a.split("/");
  const right = b.split("/");
  for (let i = 0; i < Math.min(left.length, right.length); i += 1) {
    if (left[i] === right[i]) continue;
    const [x, y] = [Number(left[i]), Number(right[i])];
    if (Number.isInteger(x) && Number.isInteger(y)) return x - y;
    return left[i]! < right[i]! ? -1 : 1;
  }
  return left.length - right.length;
}

/**
 * How a validated document's sections for disabled modules are checked. `advisory`: each
 * problem is an info finding ("would fail when enabled"); `strict`: problems keep their
 * real severity, and the section is held to its layer ownership and overlay references.
 */
export type DisabledSections = "advisory" | "strict";

/** A host/service reference found in a document. */
export interface ReferenceTarget {
  host: string;
  service?: string;
  /** Pointer to the referencing value. */
  pointer: string;
  /** Where a finding about it is reported: the unresolved field, or the value itself. */
  path: string;
}

/**
 * Every host/service reference a declaration describes: each value at its key path with a
 * string host field (and, when present, a string service field).
 */
export function referenceTargets(document: unknown, reference: ComposedReference): ReferenceTarget[] {
  const targets: ReferenceTarget[] = [];
  const visit = (value: unknown, steps: readonly string[], pointer: string): void => {
    if (steps.length === 0) {
      if (isObject(value) && typeof value[reference.host] === "string") {
        const service = value[reference.service];
        const named = typeof service === "string";
        const field = named ? reference.service : reference.host;
        targets.push({
          host: value[reference.host] as string,
          ...(named ? { service } : {}),
          pointer,
          path: reference.at === "element" ? pointer : `${pointer}/${escapePointer(field)}`,
        });
      }
      return;
    }
    const [step, ...rest] = steps;
    const each = step!.endsWith("[]");
    const key = each ? step!.slice(0, -2) : step!;
    if (!isObject(value) || !Object.prototype.hasOwnProperty.call(value, key)) return;
    const child = value[key];
    const childPointer = `${pointer}/${escapePointer(key)}`;
    if (!each) visit(child, rest, childPointer);
    else if (Array.isArray(child)) child.forEach((element, index) => visit(element, rest, `${childPointer}/${index}`));
  };
  visit(document, reference.path.split("."), "");
  return targets;
}

/** The references that do not resolve against the document's own hosts and services. */
function unresolvedReferences(document: JsonObject, references: readonly ComposedReference[]): Finding[] {
  const hosts = new Set<string>();
  const services = new Set<string>();
  for (const host of Array.isArray(document.hosts) ? document.hosts : []) {
    if (isObject(host) && typeof host.name === "string") hosts.add(host.name);
  }
  for (const service of Array.isArray(document.services) ? document.services : []) {
    if (isObject(service) && typeof service.host === "string" && typeof service.name === "string") services.add(`${service.host}\0${service.name}`);
  }
  const findings: Finding[] = [];
  for (const reference of references) {
    for (const { host, service, path } of referenceTargets(document, reference)) {
      if (service !== undefined) {
        if (services.has(`${host}\0${service}`)) continue;
        findings.push({ code: "REF_SERVICE_UNRESOLVED", severity: FINDING_CATALOG.REF_SERVICE_UNRESOLVED.severity, path, message: `service reference at ${path} does not resolve` });
      } else if (!hosts.has(host)) {
        findings.push({ code: "REF_HOST_UNRESOLVED", severity: FINDING_CATALOG.REF_HOST_UNRESOLVED.severity, path, message: `host reference at ${path} does not resolve` });
      }
    }
  }
  return findings;
}

/** Every array at a key path such as `modules.<id>.lists[].items`, with its pointer. */
function arraysAt(value: JsonValue | undefined, steps: readonly string[], pointer: string): Array<{ array: JsonValue[]; pointer: string }> {
  if (steps.length === 0) return Array.isArray(value) ? [{ array: value, pointer }] : [];
  const [step, ...rest] = steps;
  const each = step!.endsWith("[]");
  const key = each ? step!.slice(0, -2) : step!;
  if (!isObject(value) || !Object.prototype.hasOwnProperty.call(value, key)) return [];
  const child = value[key];
  const childPointer = `${pointer}/${escapePointer(key)}`;
  if (!each) return arraysAt(child, rest, childPointer);
  if (!Array.isArray(child)) return [];
  return child.flatMap((element, index) => arraysAt(element, rest, `${childPointer}/${index}`));
}

/** Key paths of identity fields: an overlay restates them to address a base element. */
export function identityLeaves(identity: Readonly<Record<string, IdentitySpec>>): ReadonlySet<string> {
  const paths = new Set<string>();
  for (const [arrayPath, spec] of Object.entries(identity)) {
    const keys = Array.isArray(spec) ? spec : Object.values(spec as Readonly<Record<string, readonly string[]>>).flat();
    for (const key of keys) paths.add(`${arrayPath}[].${key}`);
    if (!Array.isArray(spec)) paths.add(`${arrayPath}[].type`);
  }
  return paths;
}

function resolveLocal(root: JsonObject, ref: string): JsonValue | undefined {
  let node: JsonValue | undefined = root;
  for (const segment of ref.slice(2).split("/")) {
    if (!isObject(node)) return undefined;
    node = node[unescapePointer(segment)];
  }
  return node;
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function escapePointer(key: string): string {
  return key.replaceAll("~", "~0").replaceAll("/", "~1");
}

function unescapePointer(segment: string): string {
  return segment.replaceAll("~1", "/").replaceAll("~0", "~");
}
