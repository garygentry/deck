import { CONFIG_PAGE_COMPONENT, type UiExtension } from "@deck/module-sdk";
import { useEffect, useLayoutEffect, useSyncExternalStore, type ComponentType } from "react";
import { LoadingState, setContributedIcons } from "@/ui";

import { useUiManifest, type UiManifestState } from "../data/index.js";
import type { Extension, ExtensionId, PageRegistration } from "../registry/registry-types.js";
import { ModuleProblemPage, ModuleProblemTile } from "./ModuleProblem.js";
import {
  getRuntimeComponent,
  getRuntimeModuleState,
  getRuntimeModulesVersion,
  loadRuntimeWebModules,
  runtimeWebModulesOf,
  subscribeRuntimeModules,
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

/** Ids of the modules whose web half the shell loads (the loader's own test). */
export function runtimeModuleIds(manifest: UiManifestState): Set<string> {
  return manifest.status === "ready" ? new Set(runtimeWebModulesOf(manifest.manifest).map((module) => module.id)) : new Set();
}

/**
 * What stands in for a runtime module's contribution the web has not registered: nothing to
 * show yet while its web half loads (or has yet to start), else the problem it ended with. A
 * module that loaded but registered nothing for the contribution has failed for it.
 */
function terminalState(module: string): "incompatible" | "failed" | undefined {
  const state = getRuntimeModuleState(module);
  if (state === undefined || state === "pending") return undefined;
  return state === "incompatible" ? "incompatible" : "failed";
}

/** One stand-in route component per page id, kept across renders so the router never remounts it. */
const pageStandIns = new Map<string, ComponentType>();

function pageStandIn(id: string, module: string, title: string): ComponentType {
  let component = pageStandIns.get(id);
  if (component === undefined) {
    component = function RuntimePageStandIn() {
      useRuntimeModulesVersion();
      const state = terminalState(module);
      return state === undefined ? <LoadingState label="Loading page…" /> : <ModuleProblemPage module={module} state={state} title={title} />;
    };
    pageStandIns.set(id, component);
  }
  return component;
}

/**
 * The routes of runtime modules' pages, from the current UI manifest: each page at the path the
 * manifest gives it, rendering its module's component once the module is ready, so a `ui` hot
 * reload that moves a page or switches it on takes effect without loading the module again.
 * Until then it stands in: loading while the web half loads, and the module-problem page once
 * the module has settled without a component for it, so a deep link never flashes "not found".
 */
export function runtimePageRegistrations(manifest: UiManifestState, registered: readonly PageRegistration[]): PageRegistration[] {
  const modules = runtimeModuleIds(manifest);
  if (manifest.status !== "ready" || modules.size === 0 || !Array.isArray(manifest.manifest.pages)) return [];
  const have = new Set<string>(registered.map((page) => page.id));
  return manifest.manifest.pages
    // A config page (ConfigPage) routes through the config-page routes, whoever contributes it.
    .filter((page) => modules.has(page.module) && !have.has(page.id) && page.component !== CONFIG_PAGE_COMPONENT)
    .map((page) => ({
      id: page.id,
      path: page.path,
      label: page.title,
      ...(page.icon === undefined ? {} : { icon: page.icon }),
      component: runtimeComponent(page.module, page.component) ?? pageStandIn(page.id, page.module, page.title),
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

/** A ready module's component by name; undefined until it is ready, or if it has none. */
function runtimeComponent(module: string, name: string): ComponentType | undefined {
  return getRuntimeModuleState(module) === "ready" ? getRuntimeComponent(module, name) : undefined;
}

/**
 * What a slot renders for a manifest entry of a runtime module, where and with what config the
 * current manifest says: its module's component once ready; the module-problem tile once the
 * module has settled without one; nothing while it loads, or for a module that is not a
 * runtime one.
 */
export function runtimeExtensionStandIn(entry: UiExtension, runtimeModules: ReadonlySet<string>): Extension | undefined {
  if (!runtimeModules.has(entry.module) || entry.component === undefined) return undefined;
  const component = runtimeComponent(entry.module, entry.component);
  const state = terminalState(entry.module);
  if (component === undefined && state === undefined) return undefined;
  return {
    id: entry.id as ExtensionId,
    kind: entry.kind,
    module: entry.module,
    attachTo: { slot: entry.slot, order: entry.order },
    enabled: true,
    config: Object.freeze({ ...(entry.config ?? {}) }),
    component: component ?? tileStandIn(entry.module, state!),
  };
}
