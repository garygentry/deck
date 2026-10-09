import { satisfiesDeckApi, type ModuleManifest, type UiManifest, type UiModule, type WebModule, type WebModuleManifest } from "@deck/module-sdk";
import type { ComponentType } from "react";
import { FragmentBoundary } from "@/ui";

import { isComponent, registerWidgetType, type WidgetProps } from "../registry/registry.js";
import { ModuleProblemPage, ModuleProblemTile } from "./ModuleProblem.js";

/**
 * Where a runtime module's web half stands in this page load:
 * - `pending`: being loaded; its pages show a loading state and its extensions nothing;
 * - `ready`: its components are loaded, and render wherever the current UI manifest places
 *   its pages and extensions (so a `ui` hot reload moves them without loading it again);
 * - `incompatible`: its web half was built for another deck module API (`deckApi`), for
 *   another build of the module (id or version differ from the server's), or imports a name
 *   deck's `@deck/sdk` or React does not export;
 * - `failed`: it did not load, did not export a web module, declares other contributions than
 *   the module the server loaded, lacks a component the server's manifest names, or the
 *   registry refused one of its widget types.
 * A module is loaded at most once per page load: a failure is not retried until a reload.
 */
export type RuntimeModuleState = "pending" | "ready" | "incompatible" | "failed";

const states = new Map<string, RuntimeModuleState>();
/** Each ready module's components by name, each already inside its error boundary. */
const tables = new Map<string, ReadonlyMap<string, ComponentType<any>>>();
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

/** A ready runtime module's component, inside its error boundary; undefined if it has none by that name. */
export function getRuntimeComponent(module: string, name: string): ComponentType<any> | undefined {
  return tables.get(module)?.get(name);
}

export function subscribeRuntimeModules(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getRuntimeModulesVersion(): number {
  return version;
}

export interface Loaders {
  /** Import a URL natively, so the module's bare imports resolve through the page's import map. */
  importer: (url: string) => Promise<unknown>;
  /** Read JSON from deck's own server (the module's `deck-module.json`). */
  fetchJson: (url: string) => Promise<unknown>;
}

const NATIVE: Loaders = {
  importer: (url) => import(/* @vite-ignore */ url),
  fetchJson: async (url) => {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${url} answered ${response.status}`);
    return response.json();
  },
};

type RuntimeWebModule = UiModule & { web: NonNullable<UiModule["web"]> };

/**
 * The modules of a manifest whose web half the shell loads: enabled, with a script (and any
 * stylesheet) under their own `/modules/<id>/`. The one test for "a runtime module with a web
 * half", which the loader and the stand-ins share.
 */
export function runtimeWebModulesOf(manifest: UiManifest): RuntimeWebModule[] {
  const modules = Array.isArray(manifest.modules) ? manifest.modules : [];
  return modules.filter((module): module is RuntimeWebModule =>
    module?.enabled === true &&
    typeof module.web?.script === "string" &&
    module.web.script.startsWith(`/modules/${module.id}/`) &&
    (module.web.styles === undefined || (typeof module.web.styles === "string" && module.web.styles.startsWith(`/modules/${module.id}/`))),
  );
}

/**
 * Load the web half of every runtime module of the manifest this page has not tried yet, all
 * at once. Resolves when each has settled.
 */
export function loadRuntimeWebModules(manifest: UiManifest, loaders: Partial<Loaders> = {}): Promise<void> {
  const use = { ...NATIVE, ...loaders };
  return Promise.all(runtimeWebModulesOf(manifest).filter((module) => !states.has(module.id)).map((module) => loadOne(module, use))).then(() => undefined);
}

/** A web half deck cannot run: incompatible, or failed, with the cause for the console. */
class Unusable extends Error {
  constructor(
    readonly state: "incompatible" | "failed",
    message: string,
  ) {
    super(message);
  }
}

async function loadOne(module: RuntimeWebModule, loaders: Loaders): Promise<void> {
  setState(module.id, "pending");
  const link = module.web.styles === undefined ? undefined : linkStyles(module.id, module.web.styles);
  try {
    // The stylesheet first, so the components never render unstyled; the manifest the server loaded beside it.
    const served = (await Promise.all([link?.loaded, loaders.fetchJson(`/modules/${module.id}/deck-module.json`)]))[1] as ModuleManifest;
    const exported = await loaders.importer(module.web.script).catch((cause: unknown) => {
      // A name deck does not export fails at link time: the module was built for another deck.
      if (isMissingExport(cause)) throw new Unusable("incompatible", `it imports a name deck does not export (${(cause as Error).message})`);
      throw cause;
    });
    const web = asWebModule((exported as { default?: unknown } | null)?.default);
    if (web === null) throw new Unusable("failed", `${module.web.script} has no default export of a web module (defineWebModule(manifest, { components }))`);
    const { id, version: moduleVersion, deckApi } = web.manifest;
    if (id !== module.id || moduleVersion !== module.version || typeof deckApi !== "string" || !satisfiesDeckApi(deckApi)) {
      throw new Unusable("incompatible", `its web half is ${String(id)}@${String(moduleVersion)} for deckApi ${String(deckApi)}, the server runs ${module.id}@${module.version}`);
    }
    const drift = contributionDrift(web.manifest, served);
    if (drift !== null) throw new Unusable("failed", `its web half declares other ${drift} than the module the server loaded`);
    const table = guarded(module.id, served, web);
    for (const type of served.contributes?.widgetTypes ?? []) {
      if (type.component !== undefined) registerWidgetType({ type: type.type, module: module.id, component: table.get(type.component) as ComponentType<WidgetProps<any>> });
    }
    tables.set(module.id, table);
    setState(module.id, "ready");
  } catch (cause) {
    const state = cause instanceof Unusable ? cause.state : "failed";
    console.error(`[deck] runtime module "${module.id}" ${state === "incompatible" ? "is incompatible" : "failed to load"}:`, cause instanceof Unusable ? cause.message : cause);
    link?.element.remove();
    setState(module.id, state);
  }
}

/** Whether an import failed because the module imports a name its dependency does not export. */
function isMissingExport(cause: unknown): boolean {
  // Chromium: "does not provide an export named"; Firefox: "import not found"; WebKit: "Importing binding name … is not found".
  return cause instanceof SyntaxError && /does not provide an export named|import not found|binding name .* is not found/i.test(cause.message);
}

function asWebModule(value: unknown): WebModule | null {
  if (value === null || typeof value !== "object") return null;
  const { manifest, components } = value as Partial<WebModule>;
  if (manifest === null || typeof manifest !== "object" || components === null || typeof components !== "object") return null;
  return value as WebModule;
}

/** The ids of what a manifest contributes, by kind, sorted. */
function contributionIds(manifest: Pick<ModuleManifest, "contributes"> | null | undefined): Record<string, string> {
  const contributes = (manifest?.contributes ?? {}) as Record<string, unknown>;
  const ids = (list: unknown, key: string) =>
    (Array.isArray(list) ? list : []).map((entry) => String((entry as Record<string, unknown> | null)?.[key])).sort().join("\n");
  return {
    pages: ids(contributes.pages, "id"),
    "nav entries": ids(contributes.nav, "id"),
    slots: ids(contributes.slots, "id"),
    extensions: ids(contributes.extensions, "id"),
    "widget types": ids(contributes.widgetTypes, "type"),
  };
}

/** Which kind of contribution the web half declares differently from the server's manifest, or null. */
function contributionDrift(web: WebModuleManifest, served: ModuleManifest): string | null {
  const ours = contributionIds(web);
  const theirs = contributionIds(served);
  return Object.keys(ours).find((kind) => ours[kind] !== theirs[kind]) ?? null;
}

/** How long a module's stylesheet may hold up its script. */
const STYLES_WAIT_MS = 5_000;

/**
 * Link a module's stylesheet; `loaded` settles when it loads or fails (at most
 * {@link STYLES_WAIT_MS}). A stylesheet that fails is no reason to refuse the module.
 */
function linkStyles(moduleId: string, href: string): { element: HTMLLinkElement; loaded: Promise<void> } {
  const element = document.createElement("link");
  element.rel = "stylesheet";
  element.href = href;
  element.dataset.deckModule = moduleId;
  const loaded = new Promise<void>((resolve) => {
    setTimeout(resolve, STYLES_WAIT_MS);
    element.onload = element.onerror = () => resolve();
  });
  document.head.append(element);
  return { element, loaded };
}

/**
 * The module's components, each inside an error boundary of its own: a page that throws
 * renders the module-failed page, any other extension the module-failed tile, and the rest of
 * the shell (and the module's other extensions) keep rendering. Every component the server's
 * manifest names must be there; others are kept, unused.
 */
function guarded(moduleId: string, served: ModuleManifest, web: WebModule): ReadonlyMap<string, ComponentType<any>> {
  const contributes = served.contributes ?? {};
  const pages = new Set((contributes.pages ?? []).map((page) => page.component));
  const named = [
    ...pages,
    ...(contributes.extensions ?? []).flatMap((extension) => (extension.component === undefined ? [] : [extension.component])),
    ...(contributes.widgetTypes ?? []).flatMap((type) => (type.component === undefined ? [] : [type.component])),
  ];
  const table = new Map<string, ComponentType<any>>();
  for (const [name, component] of Object.entries(web.components)) {
    if (isComponent(component)) table.set(name, guard(component as ComponentType<Record<string, unknown>>, moduleId, pages.has(name)));
  }
  const missing = named.find((name) => !table.has(name));
  if (missing !== undefined) throw new Unusable("failed", `its web half has no component "${missing}", which its manifest names`);
  return table;
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
