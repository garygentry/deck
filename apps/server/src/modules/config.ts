import {
  BUILTIN_CONTRIBUTIONS,
  ComposeError,
  composeConfig,
  type ComposedConfig,
  type ConfigContribution,
  type DisabledSections,
  type Finding,
  type JsonObject,
  MODULE_HOST_FINDING_CATALOG,
} from "@deck/schema";
import { composeChecked } from "@deck/schema/select";
import { MODULE_ID_PATTERN, type ModuleManifest, type ServerModule, type WidgetTypeDecl } from "@deck/module-sdk";

import { BUILTIN_MODULES } from "./builtin.js";
import { credentialEnvRefusal, declaredCredentialEnv } from "./context.js";
import { RESERVED_MODULE_IDS } from "../ui/validate.js";
import { moduleKindsProblem, planModules, type PlanOptions } from "./host.js";

const BUILTIN_SET: ReadonlySet<ServerModule<any>> = new Set(BUILTIN_MODULES);

/** The config contract composed for a set of server modules. */
export interface ModuleComposition {
  composed: ComposedConfig;
  /**
   * Modules whose config contribution is unusable on its own (a schema that does not
   * compile, a malformed finding code), by id, with the reason. They are composed as
   * disabled, and the module host disables them with MODULE_MANIFEST_INVALID.
   */
  invalid: ReadonlyMap<string, string>;
  /** What checking instances' `credentialEnv` needs: see {@link credentialEnvFindings}. */
  credentials: CredentialOwners;
}

/** A provider kind's owning module, the instance list it reads, and whether the module runs. */
export interface KindOwner {
  manifest: ModuleManifest;
  instanceList: "integrations" | "sources";
  enabled: boolean;
}

/** The usable modules' provider kinds, and which module owns each env name. */
export interface CredentialOwners {
  /** Provider kind to the module declaring it: an enabled one, else a usable one switched off. */
  kinds: ReadonlyMap<string, KindOwner>;
  /** Env name to owning module. */
  envOwners: ReadonlyMap<string, string>;
}

/** How {@link credentialEnvFindings} reports. */
export interface CredentialCheckOptions {
  /** Loading for boot: report at info, so a refusal never stops the server (it logs a warn). */
  boot?: boolean;
  /** `strict` (`deck validate`): also check the kinds of modules that are switched off. */
  disabledSections?: DisabledSections;
}

/**
 * MODULE_CREDENTIAL_ENV_REFUSED for every `integrations[]` / `sources[]` instance whose
 * `credentialEnv` its kind's module may not read (a kernel setting or another module's name):
 * the same refusal boot logs, for every kind. Instances of a running module's kinds are always
 * checked; under `strict` validation, so are those of a switched-off module's kinds, reported as
 * what would fail when it is enabled. At the catalogued severity, except when loading for boot.
 */
export function credentialEnvFindings(document: unknown, owners: CredentialOwners, options: CredentialCheckOptions = {}): Finding[] {
  if (document === null || typeof document !== "object") return [];
  const { severity, fix } = MODULE_HOST_FINDING_CATALOG.MODULE_CREDENTIAL_ENV_REFUSED;
  const strict = options.disabledSections === "strict" && options.boot !== true;
  const findings: Finding[] = [];
  // Document order: integrations, then sources, each by index.
  for (const instanceList of ["integrations", "sources"] as const) {
    const list = (document as Record<string, unknown>)[instanceList];
    if (!Array.isArray(list)) continue;
    for (const [index, instance] of list.entries()) {
      const kind = (instance as { kind?: unknown } | null)?.kind;
      const owner = typeof kind === "string" ? owners.kinds.get(kind) : undefined;
      if (owner === undefined || owner.instanceList !== instanceList || (!owner.enabled && !strict)) continue;
      const name = declaredCredentialEnv(owner.manifest, instance);
      const refusal = name === null ? null : credentialEnvRefusal(name, owner.manifest.id, owners.envOwners);
      if (refusal === null) continue;
      const id = (instance as { id?: unknown }).id;
      const message = `${instanceList} ${JSON.stringify(id)} (kind "${kind}"): module "${owner.manifest.id}" may not read credentialEnv ${name}: it is ${refusal}.`;
      findings.push({
        code: "MODULE_CREDENTIAL_ENV_REFUSED",
        severity: options.boot === true ? "info" : severity,
        path: `/${instanceList}/${index}/credentialEnv`,
        message: owner.enabled ? message : `would fail when "${owner.manifest.id}" is enabled: ${message}`,
        hint: fix,
      });
    }
  }
  return findings;
}

/** A module's config contribution: its manifest's `config` and `providerKinds`, plus its rules. */
export function moduleContribution(module: ServerModule<any>): ConfigContribution {
  const { manifest } = module;
  const config = manifest.config;
  return {
    id: manifest.id,
    ...(config === undefined ? {} : { schema: config.schema as JsonObject }),
    ...(config?.ownership === undefined ? {} : { ownership: config.ownership }),
    ...(config?.identity === undefined ? {} : { identity: config.identity }),
    ...(config?.unique === undefined ? {} : { unique: config.unique }),
    ...(config?.findings === undefined ? {} : { findings: config.findings }),
    ...(config?.references === undefined ? {} : { references: config.references }),
    ...(manifest.providerKinds === undefined
      ? {}
      : {
          providerKinds: manifest.providerKinds.map(({ kind, instanceSchema, instanceList, bindable, findings, fixedId }) => {
            const validate = module.kinds?.[kind]?.validate;
            return {
              kind,
              ...(instanceSchema === undefined ? {} : { instanceSchema: instanceSchema as JsonObject }),
              ...(instanceList === undefined ? {} : { instanceList }),
              ...(bindable === undefined ? {} : { bindable }),
              ...(findings === undefined ? {} : { findings }),
              ...(validate === undefined ? {} : { validate }),
              // A fixed provider id is a built-in-only privilege.
              ...(fixedId === undefined || !BUILTIN_SET.has(module) ? {} : { fixedId }),
            };
          }),
        }),
    ...(manifest.contributes?.widgetTypes === undefined ? {} : { widgetTypes: widgetTypeContributions(manifest.contributes.widgetTypes) }),
    ...(module.configRules === undefined ? {} : { rules: module.configRules }),
  };
}

/** Widget types' option schemas, as composition takes them. */
function widgetTypeContributions(types: readonly WidgetTypeDecl[]): ConfigContribution["widgetTypes"] {
  return types.map(({ type, optionsSchema }) => ({ type, ...(optionsSchema === undefined ? {} : { optionsSchema: optionsSchema as JsonObject }) }));
}

/**
 * Compose the kernel, the built-in contributions not yet carried by a module, and the
 * modules the host would enable. Planning reads manifests only (as the host does, without
 * the kernel route table): an enabled module contributes its schema, rules and provider
 * kinds; a known module that will not run (switched off, refused, or with a contribution
 * that does not compose on its own) contributes only its id, so a section for it is
 * accepted and reported rather than rejected as unknown. Two enabled modules that cannot
 * coexist throw {@link ComposeError} with MODULE_MANIFEST_CONFLICT, which fails boot.
 */
export function composeModules(
  modules: readonly ServerModule<any>[],
  context: Pick<PlanOptions, "sectionOf" | "env" | "kernelRoutes" | "reservedRootPaths" | "runtime">,
  cache?: Map<string, ComposedConfig>,
): ModuleComposition {
  const invalid = new Map<string, string>();
  const contributions = new Map<string, ConfigContribution>();
  for (const module of modules) {
    const id = module.manifest?.id;
    // The host reports a malformed id itself; there is no `modules.<id>` key to compose.
    if (typeof id !== "string" || !MODULE_ID_PATTERN.test(id)) continue;
    // A module-local kind defect (a kind declared twice, say) disables the module, as the
    // host would, rather than surfacing as a conflict from composition.
    // Its declared kinds are kept, so config validation can name their owner as off.
    // A runtime module present by its manifest only has no handlers, and never runs.
    const kindProblem = context.runtime?.codeless.has(id) === true ? null : moduleKindsProblem(module);
    if (kindProblem !== null) {
      invalid.set(id, kindProblem);
      try {
        const contribution = moduleContribution(module);
        composeConfig([{ ...contribution, disabled: kindProblem }]);
        contributions.set(id, contribution);
      } catch {
        // Unusable on other counts too: it composes as an id only.
      }
      continue;
    }
    try {
      const contribution = moduleContribution(module);
      composeConfig([contribution]);
      contributions.set(id, contribution);
    } catch (error) {
      if (error instanceof ComposeError && error.code === "MODULE_MANIFEST_CONFLICT") throw error;
      invalid.set(id, `config contribution is unusable: ${(error as Error).message}`);
    }
  }

  // Throws ModuleManifestError (MODULE_MANIFEST_CONFLICT) for modules that cannot coexist,
  // exactly as the host would at boot.
  const { plan, usable, envOwners } = planModules({ modules, ...context, manifestProblems: invalid, builtins: BUILTIN_SET });
  // Enabled modules' kinds first; a usable module that is switched off fills in the rest.
  const kinds = new Map<string, KindOwner>();
  for (const enabled of [true, false]) {
    for (const entry of plan) {
      const manifest = entry.enabled === enabled ? usable.get(entry.id)?.manifest : undefined;
      for (const decl of manifest?.providerKinds ?? []) {
        if (!kinds.has(decl.kind)) kinds.set(decl.kind, { manifest: manifest!, instanceList: decl.instanceList ?? "integrations", enabled });
      }
    }
  }
  const composedModules: ConfigContribution[] = [];
  for (const entry of plan) {
    if (!MODULE_ID_PATTERN.test(entry.id)) continue;
    // A module may not take a kernel id (the host refuses it); the kernel's `core` contributes.
    if (RESERVED_MODULE_IDS.has(entry.id)) continue;
    const contribution = contributions.get(entry.id);
    if (entry.enabled && contribution !== undefined) composedModules.push(contribution);
    // Off, but with a contribution that composes: its section is still checked, at info,
    // except for a module that was meant to run but failed to load: its section is config the
    // operator wrote for it, checked at its real severity.
    else {
      const strict = context.runtime?.loadProblems.has(entry.id) === true;
      composedModules.push({ ...(contribution ?? { id: entry.id }), disabled: entry.reason ?? "not enabled", ...(strict ? { strictSection: true } : {}) });
    }
  }
  const key = JSON.stringify(composedModules.map(({ id, disabled, strictSection }) => [id, disabled ?? null, strictSection ?? false]));
  let composed = cache?.get(key);
  if (composed === undefined) {
    // Always with the select check: every server validation goes through this composition.
    composed = composeChecked([...BUILTIN_CONTRIBUTIONS, ...composedModules]);
    cache?.set(key, composed);
  }
  return { composed, invalid, credentials: { kinds, envOwners } };
}

const builtinCache = new Map<string, ComposedConfig>();

/**
 * The composition deck boots and validates with: the built-in modules, planned for
 * `context`. Memoised per plan outcome, since boot and every validate repeat it.
 */
export function builtinComposition(
  context: Pick<PlanOptions, "sectionOf" | "env" | "kernelRoutes" | "reservedRootPaths">,
): ModuleComposition {
  return composeModules(BUILTIN_MODULES, context, builtinCache);
}
