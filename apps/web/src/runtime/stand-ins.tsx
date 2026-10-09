import type { UiExtension } from "@deck/module-sdk";
import { useEffect, useLayoutEffect, useSyncExternalStore, type ComponentType } from "react";
import { LoadingState, setContributedIcons } from "@/ui";

import { useUiManifest, type UiManifestState } from "../data/index.js";
import type { Extension, ExtensionId, PageRegistration } from "../registry/registry-types.js";
import { ModuleProblemPage, ModuleProblemTile } from "./ModuleProblem.js";
import {
  getRuntimeModuleState,
  getRuntimeModulesVersion,
  loadRuntimeWebModules,
  subscribeRuntimeModules,
  type RuntimeModuleState,
} from "./runtime-modules.js";

/**
 * Load runtime modules' web halves once the UI manifest is ready, and keep the contributed
 * icons in step with it. Mounted once, in the shell.
 */
export function useRuntimeModules(): void {
  const manifest = useUiManifest();
  const ready = manifest.status === "ready" ? manifest.manifest : undefined;
  // Before paint, so a contributed nav or page icon never flashes the fallback.
  useLayoutEffect(() => {
    if (ready !== undefined) setContributedIcons(ready.icons);
  }, [ready]);
  useEffect(() => {
    if (ready !== undefined) void loadRuntimeWebModules(ready);
  }, [ready]);
}

/** Re-render on any runtime module's state change. */
export function useRuntimeModulesVersion(): number {
  return useSyncExternalStore(subscribeRuntimeModules, getRuntimeModulesVersion, getRuntimeModulesVersion);
}

/** Ids of the modules the manifest offers a web half for. */
export function runtimeModuleIds(manifest: UiManifestState): Set<string> {
  if (manifest.status !== "ready" || !Array.isArray(manifest.manifest.modules)) return new Set();
  return new Set(manifest.manifest.modules.filter((module) => module?.enabled === true && module.web !== undefined).map((module) => module.id));
}

/** One stand-in route component per page id, kept across renders so the router never remounts it. */
const pageStandIns = new Map<string, ComponentType>();

function pageStandIn(id: string, module: string, title: string): ComponentType {
  let component = pageStandIns.get(id);
  if (component === undefined) {
    component = function RuntimePageStandIn() {
      useRuntimeModulesVersion();
      const state = getRuntimeModuleState(module);
      return state === "incompatible" || state === "failed" ? <ModuleProblemPage module={module} state={state} title={title} /> : <LoadingState label="Loading page…" />;
    };
    pageStandIns.set(id, component);
  }
  return component;
}

/**
 * Stand-in routes for a runtime module's pages the web has not registered (yet): loading while
 * its web half loads, the module-problem page once it cannot render. A page the module
 * registers replaces its stand-in, so a deep link never flashes "not found".
 */
export function runtimePageRegistrations(manifest: UiManifestState, registered: readonly PageRegistration[]): PageRegistration[] {
  const modules = runtimeModuleIds(manifest);
  if (manifest.status !== "ready" || modules.size === 0 || !Array.isArray(manifest.manifest.pages)) return [];
  const have = new Set<string>(registered.map((page) => page.id));
  return manifest.manifest.pages
    .filter((page) => modules.has(page.module) && !have.has(page.id))
    .map((page) => ({
      id: page.id,
      path: page.path,
      label: page.title,
      ...(page.icon === undefined ? {} : { icon: page.icon }),
      component: pageStandIn(page.id, page.module, page.title),
    }));
}

const tileStandIns = new Map<string, ComponentType>();

function tileStandIn(module: string, state: "incompatible" | "failed"): ComponentType {
  const key = `${module}\0${state}`;
  let component = tileStandIns.get(key);
  if (component === undefined) {
    component = function RuntimeExtensionStandIn() {
      return <ModuleProblemTile module={module} state={state} />;
    };
    tileStandIns.set(key, component);
  }
  return component;
}

/**
 * What a slot renders for a manifest entry the web registered nothing for: the module-problem
 * tile when the entry's module is a runtime module whose web half cannot render; nothing
 * otherwise (still loading, or not a runtime module).
 */
export function runtimeExtensionStandIn(entry: UiExtension, runtimeModules: ReadonlySet<string>): Extension | undefined {
  if (!runtimeModules.has(entry.module) || entry.component === undefined) return undefined;
  const state: RuntimeModuleState | undefined = getRuntimeModuleState(entry.module);
  if (state !== "incompatible" && state !== "failed") return undefined;
  return {
    id: entry.id as ExtensionId,
    kind: entry.kind,
    module: entry.module,
    attachTo: { slot: entry.slot, order: entry.order },
    enabled: true,
    config: Object.freeze({ ...(entry.config ?? {}) }),
    component: tileStandIn(entry.module, state),
  };
}
