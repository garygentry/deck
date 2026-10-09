import { satisfiesDeckApi, type UiManifest, type UiModule, type WebModule } from "@deck/module-sdk";
import type { ComponentType } from "react";
import { FragmentBoundary } from "@/ui";

import { isComponent } from "../registry/registry.js";
import { registerWebModule } from "../registry/web-module.js";
import { ModuleProblemPage, ModuleProblemTile } from "./ModuleProblem.js";

/**
 * Where a runtime module's web half stands in this page load:
 * - `pending`: being loaded; its pages show a loading state and its extensions nothing;
 * - `ready`: registered, so its components render where the UI manifest places them;
 * - `incompatible`: its web half was built for another deck module API (`deckApi`) or for
 *   another build of the module (id or version differ from the server's);
 * - `failed`: it did not import, did not export a web module, or the registry refused it.
 * A module is loaded at most once per page load: a failure is not retried until a reload.
 */
export type RuntimeModuleState = "pending" | "ready" | "incompatible" | "failed";

const states = new Map<string, RuntimeModuleState>();
let version = 0;
const listeners = new Set<() => void>();

function setState(id: string, state: RuntimeModuleState): void {
  states.set(id, state);
  version += 1;
  for (const listener of listeners) listener();
}

export function getRuntimeModuleState(id: string): RuntimeModuleState | undefined {
  return states.get(id);
}

export function subscribeRuntimeModules(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getRuntimeModulesVersion(): number {
  return version;
}

/** Forget every runtime module (tests only: a page load never unloads one). */
export function resetRuntimeModulesForTest(): void {
  states.clear();
  version += 1;
}

/** Import a URL natively, so the module's bare imports resolve through the page's import map. */
export type Importer = (url: string) => Promise<unknown>;
const nativeImport: Importer = (url) => import(/* @vite-ignore */ url);

/** The enabled modules of a manifest that offer a web half. */
function webModulesOf(manifest: UiManifest): (UiModule & { web: NonNullable<UiModule["web"]> })[] {
  const modules = Array.isArray(manifest.modules) ? manifest.modules : [];
  return modules.filter((module): module is UiModule & { web: NonNullable<UiModule["web"]> } =>
    module?.enabled === true &&
    typeof module.web?.script === "string" &&
    // Only deck's own module paths: the manifest is the server's, but read leniently.
    module.web.script.startsWith(`/modules/${module.id}/`) &&
    (module.web.styles === undefined || (typeof module.web.styles === "string" && module.web.styles.startsWith(`/modules/${module.id}/`))),
  );
}

/**
 * Load the web half of every enabled module the manifest offers one for and that this page
 * has not tried yet, all at once. Resolves when each has settled.
 */
export function loadRuntimeWebModules(manifest: UiManifest, importer: Importer = nativeImport): Promise<void> {
  return Promise.all(webModulesOf(manifest).filter((module) => !states.has(module.id)).map((module) => loadOne(module, importer))).then(() => undefined);
}

async function loadOne(module: UiModule & { web: NonNullable<UiModule["web"]> }, importer: Importer): Promise<void> {
  setState(module.id, "pending");
  try {
    if (module.web.styles !== undefined) await linkStyles(module.id, module.web.styles);
    const exported = ((await importer(module.web.script)) as { default?: unknown } | null)?.default;
    const web = asWebModule(exported);
    if (web === null) throw new Error(`${module.web.script} has no default export of a web module (defineWebModule(manifest, { components }))`);
    const { id, version: moduleVersion, deckApi } = web.manifest;
    if (id !== module.id || moduleVersion !== module.version || typeof deckApi !== "string" || !satisfiesDeckApi(deckApi)) {
      console.error(
        `[deck] runtime module "${module.id}" is incompatible: its web half is ${String(id)}@${String(moduleVersion)} for deckApi ${String(deckApi)}, the server runs ${module.id}@${module.version}`,
      );
      setState(module.id, "incompatible");
      return;
    }
    registerWebModule({ manifest: web.manifest, components: guarded(module.id, web) });
    setState(module.id, "ready");
  } catch (cause) {
    console.error(`[deck] runtime module "${module.id}" failed to load:`, cause);
    setState(module.id, "failed");
  }
}

function asWebModule(value: unknown): WebModule | null {
  if (value === null || typeof value !== "object") return null;
  const { manifest, components } = value as Partial<WebModule>;
  if (manifest === null || typeof manifest !== "object" || components === null || typeof components !== "object") return null;
  return value as WebModule;
}

/** How long a module's stylesheet may hold up its script. */
const STYLES_WAIT_MS = 5_000;

/**
 * Link a module's stylesheet and wait for it (at most {@link STYLES_WAIT_MS}), so its
 * components do not render unstyled first.
 */
function linkStyles(moduleId: string, href: string): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, STYLES_WAIT_MS);
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    link.dataset.deckModule = moduleId;
    // A stylesheet that fails is no reason to refuse the module: its components still render.
    link.onload = link.onerror = () => resolve();
    document.head.append(link);
  });
}

/**
 * The module's component table, each component inside an error boundary of its own: a page
 * that throws renders the module-failed page, any other extension the module-failed tile, and
 * the rest of the shell (and the module's other extensions) keep rendering. A table entry that
 * is not a component is left as it is, for the registry to refuse.
 */
function guarded(moduleId: string, web: WebModule): Record<string, unknown> {
  const pages = new Set((web.manifest.contributes?.pages ?? []).map((page) => page.component));
  return Object.fromEntries(
    Object.entries(web.components).map(([name, component]) => [
      name,
      isComponent(component) ? guard(component as ComponentType<Record<string, unknown>>, moduleId, pages.has(name)) : component,
    ]),
  );
}

function guard(Component: ComponentType<Record<string, unknown>>, moduleId: string, page: boolean): ComponentType<Record<string, unknown>> {
  const fallback = page ? <ModuleProblemPage module={moduleId} state="failed" /> : <ModuleProblemTile module={moduleId} state="failed" />;
  function Guarded(props: Record<string, unknown>) {
    return (
      <FragmentBoundary label={moduleId} fallback={fallback}>
        <Component {...props} />
      </FragmentBoundary>
    );
  }
  Guarded.displayName = `RuntimeModule(${moduleId})`;
  return Guarded;
}
