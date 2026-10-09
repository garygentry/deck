import { UI_CONFIG_MODULE, type UiPage } from "@deck/module-sdk";
import type { ComponentType } from "react";

import { useUiManifest, type UiManifestState } from "../../data/index.js";
import type { PageRegistration } from "../../registry/registry-types.js";
import { NotFoundPage } from "../NotFoundPage.js";
import { ConfigPage } from "./ConfigPage.js";
import { isRenderableLayout } from "./layout.js";

/** One route component per config page id, kept across renders so the router never remounts it. */
const routeComponents = new Map<string, ComponentType>();

function routeComponent(id: string): ComponentType {
  let component = routeComponents.get(id);
  if (component === undefined) {
    // It reads its page from the manifest each render, so a refreshed manifest re-renders it.
    component = function ConfigPageRoute() {
      const page = configPagesOf(useUiManifest()).find((candidate) => candidate.id === id);
      return page === undefined ? <NotFoundPage /> : <ConfigPage page={page} />;
    };
    routeComponents.set(id, component);
  }
  return component;
}

/** The config pages a ready manifest routes: its pages of module `ui` with a well-formed layout. */
function configPagesOf(manifest: UiManifestState): UiPage[] {
  if (manifest.status !== "ready" || !Array.isArray(manifest.manifest.pages)) return [];
  // A malformed entry is not routed (the server's never is); the page boundary covers the rest.
  return manifest.manifest.pages.filter(
    (page) =>
      page?.module === UI_CONFIG_MODULE &&
      typeof page.path === "string" &&
      typeof page.title === "string" &&
      isRenderableLayout(page.layout, { slots: false }),
  );
}

/**
 * Page registrations for the config pages (`ui.pages`) the UI manifest routes, so the router
 * and the fallback nav treat them like any module's page. None until the manifest loads, or
 * when it cannot be read: config pages exist only in the manifest.
 */
export function configPageRegistrations(manifest: UiManifestState): PageRegistration[] {
  return configPagesOf(manifest).map((page) => ({
    id: page.id,
    path: page.path,
    label: page.title,
    ...(page.icon === undefined ? {} : { icon: page.icon }),
    component: routeComponent(page.id),
  }));
}
