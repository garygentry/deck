import type { ModuleManifest, UiManifest } from "@deck/module-sdk";

import type { ModuleHost } from "../modules/host.js";
import type { RuntimeWebAssets } from "../modules/runtime.js";
import { webEntryOf } from "../server/module-assets.js";
import type { ProviderReader } from "../server/app.js";
import { KERNEL_FEATURES } from "./kernel-features.js";
import { configPagesOf, deriveProjections } from "./config-pages.js";
import type { RuntimePages } from "./runtime-pages.js";
import { estateNameOf, resolveUiManifest, uiConfigOf, uiOverridesOf, type UiModuleInput } from "./resolve.js";

export interface UiManifestDeps {
  config: unknown;
  /** The registered providers; their envelopes take the config pages' selects. */
  providers: Pick<ProviderReader, "listProviders" | "setProjections">;
  /** The module host: its plan, the manifests it read, and which modules are built in. */
  modules?: Pick<ModuleHost, "plan" | "manifests" | "builtinIds">;
  /** Kernel capabilities by name. */
  capabilities: Readonly<Record<string, boolean>>;
  /** The pages modules contribute at runtime now (`collectRuntimePages`). */
  runtimePages?: () => RuntimePages;
  /** The runtime modules' web halves deck serves, by id (see `servedWebModules`). */
  web?: ReadonlyMap<string, RuntimeWebAssets>;
}

/**
 * The UI manifest for a booted kernel: every planned module (with its manifest when it was
 * usable), the kernel-wired features, the registered providers, the config's overrides and its
 * pages, and the pages modules contribute at runtime. It also sets the providers' projections to the selects of its config pages' widgets.
 */
export function buildUiManifest(deps: UiManifestDeps): UiManifest {
  const modules: UiModuleInput[] = (deps.modules?.plan ?? []).map((entry) => {
    // A module whose manifest was unusable is listed by id, with nothing to contribute.
    const manifest = deps.modules?.manifests.get(entry.id) ?? unusableManifest(entry.id);
    const web = deps.web?.get(entry.id);
    return {
      manifest,
      enabled: entry.enabled,
      ...(entry.reason === undefined ? {} : { reason: entry.reason }),
      ...(entry.gates === undefined ? {} : { enabledBy: [...entry.gates] }),
      // By id: the host snapshots each manifest, and ids are unique per host.
      ...(deps.modules?.builtinIds.has(entry.id) === true ? { builtin: true } : {}),
      ...(web === undefined || !entry.enabled ? {} : { web: webEntryOf(entry.id, web) }),
    };
  });
  const estateName = estateNameOf(deps.config);
  const runtime = deps.runtimePages?.() ?? { pages: [], nav: [], findings: [] };
  const ui = resolveUiManifest({
    modules,
    kernelFeatures: KERNEL_FEATURES,
    capabilities: deps.capabilities,
    providers: deps.providers.listProviders(),
    overrides: uiOverridesOf(deps.config),
    ...(estateName === undefined ? {} : { estateName }),
    ui: uiConfigOf(deps.config),
    configPages: [...configPagesOf(deps.config), ...runtime.pages],
    runtimeNav: runtime.nav,
    moduleSections: moduleSectionsOf(deps.config),
  });
  ui.findings.push(...runtime.findings);
  // The manifest's config pages decide what each envelope projects: a rebuilt manifest
  // (a reloaded ui config) replaces the selects with its own.
  deps.providers.setProjections(deriveProjections(ui));
  return ui;
}

/** The config's `modules` sections, or none. */
function moduleSectionsOf(config: unknown): Readonly<Record<string, unknown>> {
  const modules = (config as { modules?: unknown } | null)?.modules;
  return modules !== null && typeof modules === "object" && !Array.isArray(modules) ? (modules as Record<string, unknown>) : {};
}

function unusableManifest(id: string): ModuleManifest {
  return { id, version: "unknown", deckApi: "unknown" };
}
