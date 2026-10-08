import {
  entitySectionProblem,
  EXTENSION_KINDS,
  extensionIdProblem,
  orderProblem,
  pagePathProblem,
  slotAcceptsProblem,
  slotIdProblem,
  type ExtensionDecl,
  type NavDecl,
  type WebModule,
} from "@deck/module-sdk";
import type { ComponentType } from "react";

import { defineSlot, getAllExtensions, getSlot, isComponent, registerExtension, registerPage, RegistrationError, type SlotAccepts } from "./registry.js";
import type { ExtensionId } from "./registry-types.js";

/**
 * Register a module's web half: every page, nav entry, slot and extension its manifest
 * contributes, each rendering the component the manifest names from the module's table. The
 * manifest is the only place these attach: the web adds no paths, slots or orders of its
 * own, and the UI manifest (`/api/ui`) still decides at runtime which of them render, where.
 *
 * A page's route is labelled by the page's `title` (the top bar, the document title and the
 * fallback nav); a nav entry's own `label` and `icon` show only in the manifest-driven sidebar.
 * The nav entry's `order` orders the nav, never the routes.
 *
 * Everything is checked before anything registers, so a refused module leaves no part of
 * itself behind. Refused, naming the module: a component the manifest names that the table
 * lacks, or holds as something other than a component; a table entry nothing names; an
 * extension that is neither rendered by a component nor a widget descriptor; nav entries the
 * registry cannot express (an `href` entry, one not named after its page, a second one for a
 * page); and anything the registry itself would refuse (ids, paths, orders, slot kinds,
 * entity-section config, duplicates).
 */
export function registerWebModule(module: WebModule): void {
  const { id, contributes = {} } = module.manifest;
  const context = `registerWebModule(${id})`;
  const fail = (code: ConstructorParameters<typeof RegistrationError>[0], message: string): never => {
    throw new RegistrationError(code, `${context}: ${message}`);
  };
  const table = module.components as Readonly<Record<string, unknown>>;
  const pages = contributes.pages ?? [];
  const slots = contributes.slots ?? [];
  // Widget descriptors (a `widget`, no component) render through their widget type, not here.
  const descriptor = (extension: ExtensionDecl) => extension.component === undefined && extension.widget !== undefined;
  const extensions = (contributes.extensions ?? []).filter((extension) => !descriptor(extension));

  // Components: every name the manifest references is in the table, and only those.
  for (const extension of extensions) {
    if (extension.component === undefined) fail("MISSING_FIELD", `extension "${extension.id}" names no component and is not a widget descriptor`);
  }
  const referenced = new Set([
    ...pages.map((page) => page.component),
    ...extensions.map((extension) => extension.component!),
    // Widget types render once dashboards land; their components belong in the table already.
    ...(contributes.widgetTypes ?? []).flatMap((type) => (type.component === undefined ? [] : [type.component])),
  ]);
  for (const name of referenced) {
    if (!Object.hasOwn(table, name)) fail("MISSING_FIELD", `component "${name}" is named by the manifest but missing from the component table`);
  }
  for (const name of referenced) {
    if (!isComponent(table[name])) fail("INVALID_FIELD", `component "${name}" in the component table is not a component`);
  }
  for (const name of Object.keys(table)) {
    if (!referenced.has(name)) fail("INVALID_FIELD", `component "${name}" is in the component table but no page, extension or widget type names it`);
  }

  // Nav entries: one per page, named after it.
  const navByPage = new Map<string, NavDecl>();
  for (const nav of contributes.nav ?? []) {
    if (nav.page === undefined) fail("INVALID_FIELD", `nav entry "${nav.id}" has no page; href nav entries are not supported`);
    const expected = `nav:${nav.page!.slice("page:".length)}`;
    if (nav.id !== expected) fail("INVALID_ID", `nav entry "${nav.id}" must be named after its page, "${expected}"`);
    if (navByPage.has(nav.page!)) fail("DUPLICATE_ID", `page "${nav.page}" has more than one nav entry`);
    if (!pages.some((page) => page.id === nav.page)) fail("INVALID_FIELD", `a nav entry targets "${nav.page}", which is not one of the module's pages`);
    navByPage.set(nav.page!, nav);
  }

  // Everything the registry would refuse, checked up front.
  const problem = (message: string | null) => {
    if (message !== null) fail("INVALID_FIELD", message);
  };
  const ids = [...pages.flatMap((page) => [page.id, ...(navByPage.has(page.id) ? [`nav:${page.id.slice("page:".length)}`] : [])]), ...extensions.map(({ id }) => id)];
  const taken = new Set(getAllExtensions().map(({ id }) => id as string));
  for (const extensionId of ids) {
    if (taken.has(extensionId)) fail("DUPLICATE_ID", `duplicate extension id "${extensionId}"`);
    taken.add(extensionId);
  }
  for (const page of pages) {
    problem(extensionIdProblem(page.id, { module: id, kind: "page" }));
    problem(pagePathProblem(page.path, `page "${page.id}"`));
    problem(orderProblem(navByPage.get(page.id)?.order, `nav entry for "${page.id}" order`));
    if (typeof page.title !== "string" || page.title === "") fail("MISSING_FIELD", `page "${page.id}" needs a title`);
  }
  const accepts = new Map<string, string>();
  for (const slot of slots) {
    problem(slotIdProblem(slot.id, id) ?? slotAcceptsProblem(slot.accepts, slot.id));
    if (getSlot(slot.id) !== undefined || accepts.has(slot.id)) fail("DUPLICATE_SLOT", `slot "${slot.id}" already declared`);
    accepts.set(slot.id, slot.accepts);
    const misfit = getAllExtensions().find((extension) => extension.attachTo.slot === slot.id && extension.kind !== slot.accepts);
    if (misfit !== undefined) fail("SLOT_KIND_MISMATCH", `slot "${slot.id}" accepts ${slot.accepts}, but "${misfit.id}" (${misfit.kind}) is attached`);
  }
  for (const extension of extensions) {
    problem(extensionIdProblem(extension.id, { module: id }));
    if (!EXTENSION_KINDS.includes(extension.kind)) fail("INVALID_FIELD", `extension "${extension.id}" has kind "${extension.kind}"; it must be one of ${EXTENSION_KINDS.join(", ")}`);
    if (typeof extension.attachTo?.slot !== "string" || extension.attachTo.slot === "") fail("MISSING_FIELD", `extension "${extension.id}" attaches to no slot`);
    problem(orderProblem(extension.attachTo.order, `extension "${extension.id}" order`));
    const slotAccepts = accepts.get(extension.attachTo.slot) ?? getSlot(extension.attachTo.slot)?.accepts;
    if (slotAccepts !== undefined && slotAccepts !== extension.kind) {
      fail("SLOT_KIND_MISMATCH", `extension "${extension.id}" (${extension.kind}) attaches to slot "${extension.attachTo.slot}", which accepts ${slotAccepts}`);
    }
    if (extension.kind === "entity-section") problem(entitySectionProblem(extension.config, `entity section "${extension.id}"`));
  }

  // Register.
  for (const slot of slots) defineSlot({ id: slot.id, accepts: slot.accepts as SlotAccepts, module: id });
  for (const page of pages) {
    const nav = navByPage.get(page.id);
    registerPage({
      id: page.id,
      path: page.path,
      label: page.title,
      ...(page.icon === undefined ? {} : { icon: page.icon }),
      component: table[page.component] as ComponentType,
      ...(nav === undefined ? { nav: false } : { group: nav.group }),
      ...(nav?.order === undefined ? {} : { navOrder: nav.order }),
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
