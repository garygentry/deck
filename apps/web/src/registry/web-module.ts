import type { NavDecl, WebModule } from "@deck/module-sdk";
import type { ComponentType } from "react";

import { defineSlot, registerExtension, registerPage, RegistrationError } from "./registry.js";
import type { ExtensionId } from "./registry-types.js";

/**
 * Register a module's web half: every page, nav entry, slot and extension its manifest
 * contributes, each rendering the component the manifest names from the module's table. The
 * manifest is the only place these attach: the web adds no paths, slots or orders of its
 * own, and the UI manifest (`/api/ui`) still decides at runtime which of them render, where.
 *
 * Refused, before anything registers: a name the manifest references that the table lacks,
 * a table entry nothing references, and nav entries the registry cannot express (an `href`
 * entry, one not named after its page, a second entry for one page).
 */
export function registerWebModule(module: WebModule): void {
  const { id, contributes = {} } = module.manifest;
  const context = `registerWebModule(${id})`;
  const table = module.components as Readonly<Record<string, unknown>>;
  const pages = contributes.pages ?? [];
  const extensions = (contributes.extensions ?? []).filter((extension) => extension.component !== undefined);

  const referenced = new Set([...pages.map((page) => page.component), ...extensions.map((extension) => extension.component!)]);
  for (const name of referenced) {
    if (!Object.hasOwn(table, name)) {
      throw new RegistrationError("MISSING_FIELD", `${context}: component "${name}" is named by the manifest but missing from the component table`);
    }
  }
  for (const name of Object.keys(table)) {
    if (!referenced.has(name)) {
      throw new RegistrationError("INVALID_FIELD", `${context}: component "${name}" is in the component table but no page or extension names it`);
    }
  }

  const navByPage = new Map<string, NavDecl>();
  for (const nav of contributes.nav ?? []) {
    if (nav.page === undefined) {
      throw new RegistrationError("INVALID_FIELD", `${context}: nav entry "${nav.id}" has no page; href nav entries are not supported`);
    }
    if (nav.id !== `nav:${nav.page.slice("page:".length)}`) {
      throw new RegistrationError("INVALID_ID", `${context}: nav entry "${nav.id}" must be named after its page, "nav:${nav.page.slice("page:".length)}"`);
    }
    if (navByPage.has(nav.page)) {
      throw new RegistrationError("DUPLICATE_ID", `${context}: page "${nav.page}" has more than one nav entry`);
    }
    navByPage.set(nav.page, nav);
  }
  const unknownNav = [...navByPage.keys()].find((page) => !pages.some((decl) => decl.id === page));
  if (unknownNav !== undefined) {
    throw new RegistrationError("INVALID_FIELD", `${context}: a nav entry targets "${unknownNav}", which is not one of the module's pages`);
  }

  for (const slot of contributes.slots ?? []) defineSlot({ id: slot.id, accepts: slot.accepts, module: id });
  for (const page of pages) {
    const nav = navByPage.get(page.id);
    const icon = nav?.icon ?? page.icon;
    registerPage({
      id: page.id,
      path: page.path,
      label: nav?.label ?? page.title,
      ...(icon === undefined ? {} : { icon }),
      component: table[page.component] as ComponentType,
      ...(nav === undefined ? { nav: false } : { group: nav.group }),
      ...(nav?.order === undefined ? {} : { order: nav.order }),
    });
  }
  for (const extension of extensions) {
    registerExtension({
      id: extension.id as ExtensionId,
      kind: extension.kind,
      attachTo: extension.attachTo,
      ...(extension.enabled === undefined ? {} : { enabled: extension.enabled }),
      ...(extension.config === undefined ? {} : { config: extension.config }),
      component: table[extension.component!] as ComponentType,
    });
  }
}
