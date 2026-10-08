import type { ModuleManifest, UiManifest } from "@deck/module-sdk";

import type { ModuleHost } from "../modules/host.js";
import type { ProviderReader } from "../server/app.js";
import { KERNEL_FEATURES } from "./kernel-features.js";
import { configPagesOf } from "./config-pages.js";
import { estateNameOf, resolveUiManifest, uiConfigOf, uiOverridesOf, type UiModuleInput } from "./resolve.js";

export interface UiManifestDeps {
  config: unknown;
  providers: Pick<ProviderReader, "listProviders">;
  /** The module host: its plan, the manifests it read, and which modules are built in. */
  modules?: Pick<ModuleHost, "plan" | "manifests" | "builtinIds">;
  /** Kernel capabilities by name. */
  capabilities: Readonly<Record<string, boolean>>;
}

/**
 * The UI manifest for a booted kernel: every planned module (with its manifest when it was
 * usable), the kernel-wired features, the registered providers and the config's overrides.
 */
export function buildUiManifest(deps: UiManifestDeps): UiManifest {
  const modules: UiModuleInput[] = (deps.modules?.plan ?? []).map((entry) => {
    // A module whose manifest was unusable is listed by id, with nothing to contribute.
    const manifest = deps.modules?.manifests.get(entry.id) ?? unusableManifest(entry.id);
    return {
      manifest,
      enabled: entry.enabled,
      ...(entry.reason === undefined ? {} : { reason: entry.reason }),
      ...(entry.gates === undefined ? {} : { enabledBy: [...entry.gates] }),
      // By id: the host snapshots each manifest, and ids are unique per host.
      ...(deps.modules?.builtinIds.has(entry.id) === true ? { builtin: true } : {}),
    };
  });
  const estateName = estateNameOf(deps.config);
  return resolveUiManifest({
    modules,
    kernelFeatures: KERNEL_FEATURES,
    capabilities: deps.capabilities,
    providers: deps.providers.listProviders(),
    overrides: uiOverridesOf(deps.config),
    ...(estateName === undefined ? {} : { estateName }),
    ui: uiConfigOf(deps.config),
    configPages: configPagesOf(deps.config),
  });
}

function unusableManifest(id: string): ModuleManifest {
  return { id, version: "unknown", deckApi: "unknown" };
}
