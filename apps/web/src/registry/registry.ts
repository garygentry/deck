import { SHELL_SLOTS } from "@deck/contract/modules/core";
import {
  entitySectionName,
  entitySectionProblem,
  EXTENSION_KINDS as SDK_EXTENSION_KINDS,
  orderProblem,
  pagePathProblem,
  parseExtensionId,
  slotAcceptsProblem,
  slotIdProblem,
} from "@deck/module-sdk";
import type {
  CardRegistration,
  EntityFragmentRegistration,
  EntitySection,
  Extension,
  ExtensionId,
  PageRegistration,
  SummaryFragmentRegistration,
  SummarySlot,
  WidgetTypeRegistration,
} from "./registry-types.js";

export type {
  CardRegistration,
  EntityFragmentRegistration,
  EntityRef,
  EntitySection,
  Extension,
  ExtensionId,
  IconRef,
  PageRegistration,
  SummaryFragmentRegistration,
  SummarySlot,
  WidgetProps,
  WidgetTypeRegistration,
} from "./registry-types.js";

const DEFAULT_ORDER = 100;

/** Slots the shell hosts. */
export const ROUTES_SLOT = "app/routes";
export const NAV_SLOT = "app/nav";

/** The slot an entity page's sections attach to. */
export function entitySectionsSlot(entity: "host" | "service"): string {
  return `entity:${entity}/sections`;
}

/** What a slot accepts; an extension attaches only to a slot that accepts its kind. */
export type SlotAccepts = "pill" | "widget" | "entity-section" | "action" | "page" | "nav";

/** The kinds a generic extension may have: pages and nav entries come from `registerPage`. */
export const EXTENSION_KINDS: ReadonlySet<string> = new Set(SDK_EXTENSION_KINDS);

export interface Slot {
  readonly id: string;
  readonly accepts: SlotAccepts;
  /** The module hosting the slot; its id is the slot's namespace. */
  readonly module: string;
}

const extensions = new Map<string, Extension>();
const slots = new Map<string, Slot>();
const widgetTypes = new Map<string, WidgetTypeRegistration>();
const listeners = new Set<() => void>();
let version = 0;

export class RegistrationError extends Error {
  constructor(
    readonly code:
      | "MISSING_FIELD"
      | "INVALID_ID"
      | "DUPLICATE_ID"
      | "UNKNOWN_SLOT"
      | "DUPLICATE_SLOT"
      | "INVALID_SLOT"
      | "INVALID_FIELD"
      | "SLOT_KIND_MISMATCH",
    message: string,
  ) {
    super(message);
    this.name = "RegistrationError";
  }
}

function requireString(value: unknown, field: string, context: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new RegistrationError(
      "MISSING_FIELD",
      `${context}: "${field}" must be a non-empty string`,
    );
  }
}

/** A function component or class, or a React object component (lazy, memo, forwardRef). */
export function isComponent(value: unknown): boolean {
  return (
    typeof value === "function" ||
    (typeof value === "object" && value !== null && "$$typeof" in value)
  );
}

function requireComponent(value: unknown, context: string): void {
  if (!isComponent(value)) {
    throw new RegistrationError("MISSING_FIELD", `${context}: "component" must be a component`);
  }
}

/** Parse an extension id, requiring its kind when given. */
function parseId(id: unknown, context: string, kind?: string): { kind: string; module: string } {
  requireString(id, "id", context);
  const parts = parseExtensionId(id);
  if (parts === null) {
    throw new RegistrationError("INVALID_ID", `${context}: id "${id}" must have the form <kind>:<module>/<name>`);
  }
  if (kind !== undefined && parts.kind !== kind) {
    throw new RegistrationError("INVALID_ID", `${context}: id "${id}" must start with "${kind}:"`);
  }
  return parts;
}

/** Throw INVALID_FIELD for a problem the shared UI rules found. */
function requireNoProblem(problem: string | null, context: string): void {
  if (problem !== null) throw new RegistrationError("INVALID_FIELD", `${context}: ${problem}`);
}

function byOrderThenId(left: Extension, right: Extension): number {
  return left.attachTo.order !== right.attachTo.order
    ? left.attachTo.order - right.attachTo.order
    : left.id < right.id
      ? -1
      : left.id > right.id
        ? 1
        : 0;
}

function notify(): void {
  version += 1;
  for (const listener of [...listeners]) listener();
}

/**
 * Declare a slot: a named attach point accepting one kind of extension. Its id is namespaced
 * to its host module (`<module>/<name>`); the `app/…` and `entity:…` namespaces are `core`'s.
 * Extensions may attach before their slot is declared; declaring it then checks them.
 */
export function defineSlot(slot: { id: string; accepts: SlotAccepts; module: string }): Slot {
  const context = `defineSlot(${String(slot.id)})`;
  requireString(slot.id, "id", context);
  requireString(slot.module, "module", context);
  // The same rules as the server's manifest validation: namespaced to the host module, with a
  // well-formed name; `app/…` and `entity:…` are core's.
  const problem = slotIdProblem(slot.id, slot.module, { kernel: slot.module === "core" }) ?? slotAcceptsProblem(slot.accepts, slot.id);
  if (problem !== null) throw new RegistrationError("INVALID_SLOT", `${context}: ${problem}`);
  if (slots.has(slot.id)) {
    throw new RegistrationError("DUPLICATE_SLOT", `${context}: slot "${slot.id}" already declared`);
  }
  const misfit = [...extensions.values()].find((extension) => extension.attachTo.slot === slot.id && extension.kind !== slot.accepts);
  if (misfit !== undefined) {
    throw new RegistrationError(
      "SLOT_KIND_MISMATCH",
      `${context}: "${misfit.id}" (${misfit.kind}) is attached, but the slot accepts ${slot.accepts}`,
    );
  }
  const declared: Slot = Object.freeze({ id: slot.id, accepts: slot.accepts, module: slot.module });
  slots.set(declared.id, declared);
  return declared;
}

/** A declared slot, or undefined. */
export function getSlot(id: string): Slot | undefined {
  return slots.get(id);
}

// Every slot core hosts (routes, nav, the top bar's, the entity pages'), declared here with the
// registry, so a module attaches to any of them whatever imports it first. The list is the one
// the server's UI manifest gives core.
for (const slot of SHELL_SLOTS) defineSlot({ id: slot.id, accepts: slot.accepts, module: "core" });

export interface ExtensionInput {
  id: ExtensionId;
  /** One of the extension kinds a slot can accept: `pill`, `widget`, `entity-section`, `action`. */
  kind: string;
  attachTo: { slot: string; order?: number };
  enabled?: boolean;
  config?: Record<string, unknown>;
  component?: Extension["component"];
}

/**
 * Add one extension of `kind`, with an id prefix `idPrefix`, after the common checks. Errors
 * name `caller`, the blueprint (or `registerExtension`) the module called.
 */
function addExtension(input: ExtensionInput, idPrefix?: string, caller = "registerExtension"): Extension {
  const context = `${caller}(${String(input.id)})`;
  const { module } = parseId(input.id, caller, idPrefix);
  requireString(input.attachTo?.slot, "attachTo.slot", context);
  requireNoProblem(orderProblem(input.attachTo.order, "attachTo.order"), context);
  // Everything renders a component except a nav entry, which renders its page's link.
  if (input.kind !== "nav" || input.component !== undefined) requireComponent(input.component, context);
  // An entity section's heading and section name, by the server's manifest rule, checked here so
  // every path in (a blueprint or `registerExtension`) is refused before the registry changes.
  if (input.kind === "entity-section") requireNoProblem(entitySectionProblem(input.config, "entity section"), context);
  if (extensions.has(input.id)) {
    throw new RegistrationError("DUPLICATE_ID", `${context}: duplicate extension id "${input.id}"`);
  }
  const slot = slots.get(input.attachTo.slot);
  if (slot !== undefined && slot.accepts !== input.kind) {
    throw new RegistrationError(
      "SLOT_KIND_MISMATCH",
      `${context}: slot "${slot.id}" accepts ${slot.accepts}, not ${input.kind}`,
    );
  }
  const extension: Extension = Object.freeze({
    id: input.id,
    kind: input.kind,
    module,
    attachTo: Object.freeze({ slot: input.attachTo.slot, order: input.attachTo.order ?? DEFAULT_ORDER }),
    enabled: input.enabled ?? true,
    config: Object.freeze({ ...(input.config ?? {}) }),
    ...(input.component === undefined ? {} : { component: input.component }),
  });
  extensions.set(extension.id, extension);
  notify();
  return extension;
}

/**
 * Add one extension to the tree. The `register*` blueprints below build on the same core; a
 * module contributing to a slot of its own can call this directly. Its kind must be one a
 * slot accepts other than page or nav, and its id may not use the `page:`/`nav:` prefixes
 * (those come from `registerPage`). Subscribers are notified, so slot hosts that read through
 * `useRegistryVersion` re-render.
 */
export function registerExtension(input: ExtensionInput): Extension {
  const context = `registerExtension(${String(input.id)})`;
  if (!EXTENSION_KINDS.has(input.kind)) {
    throw new RegistrationError("MISSING_FIELD", `${context}: kind must be one of ${[...EXTENSION_KINDS].join(", ")}`);
  }
  const prefix = parseId(input.id, "registerExtension").kind;
  if (prefix === "page" || prefix === "nav") {
    throw new RegistrationError("INVALID_ID", `${context}: the "${prefix}:" prefix is for registerPage`);
  }
  return addExtension(input);
}

/** The enabled extensions attached to `slot`, by order then id (a new array per call). */
export function getExtensions(slot: string): readonly Extension[] {
  return [...extensions.values()]
    .filter((extension) => extension.enabled && extension.attachTo.slot === slot)
    .sort(byOrderThenId);
}

/**
 * Extensions attached to a slot nobody declared, so they never render. Discovery reports
 * them in development; the server reports the same as an unknown-slot finding.
 */
export function getOrphanAttachments(): readonly { id: string; slot: string }[] {
  return getAllExtensions()
    .filter((extension) => !slots.has(extension.attachTo.slot))
    .map(({ id, attachTo }) => ({ id, slot: attachTo.slot }));
}

/** Every extension, enabled or not, by id. */
export function getAllExtensions(): readonly Extension[] {
  return [...extensions.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Subscribe to registry changes; returns the unsubscribe function. */
export function subscribeRegistry(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** A counter bumped on every registration, the snapshot for `useSyncExternalStore`. */
export function getRegistryVersion(): number {
  return version;
}

// ---------------------------------------------------------------------------
// Blueprints: the typed registration calls features use, each producing extensions.
// ---------------------------------------------------------------------------

/** A routed page (`app/routes`), plus its `nav:` entry (`app/nav`) unless `nav: false`. */
export function registerPage(registration: PageRegistration): void {
  parseId(registration.id, "registerPage", "page");
  requireString(registration.path, "path", "registerPage");
  requireString(registration.label, "label", "registerPage");
  requireComponent(registration.component, `registerPage(${registration.id})`);
  // Checked up front so a page and its nav entry register together or not at all.
  requireNoProblem(pagePathProblem(registration.path, "page"), `registerPage(${registration.id})`);
  requireNoProblem(orderProblem(registration.order, "order"), `registerPage(${registration.id})`);
  requireNoProblem(orderProblem(registration.navOrder, "navOrder"), `registerPage(${registration.id})`);
  if (extensions.has(registration.id)) {
    throw new RegistrationError("DUPLICATE_ID", `registerPage: duplicate page id "${registration.id}"`);
  }
  // Only registerPage mints `nav:` ids, one per page id, so the nav id is free here.
  const navId = `nav:${registration.id.slice("page:".length)}` as ExtensionId;
  const listed = registration.nav !== false;
  const { id, component, order, navOrder = order, ...page } = registration;
  addExtension({ id, kind: "page", attachTo: { slot: ROUTES_SLOT, ...(order === undefined ? {} : { order }) }, config: page, component }, "page", "registerPage");
  if (listed) {
    addExtension({ id: navId, kind: "nav", attachTo: { slot: NAV_SLOT, ...(navOrder === undefined ? {} : { order: navOrder }) }, config: { page: id } }, "nav", "registerPage");
  }
}

/** A card (a `widget`) in a host's widget slot (e.g. the portal summary). */
export function registerCard<T = unknown>(registration: CardRegistration<T>): void {
  parseId(registration.id, "registerCard", "card");
  requireString(registration.slot, "slot", "registerCard");
  requireComponent(registration.component, `registerCard(${registration.id})`);
  if (extensions.has(registration.id)) {
    throw new RegistrationError("DUPLICATE_ID", `registerCard: duplicate card id "${registration.id}"`);
  }
  const { id, slot, order, component, providerId } = registration;
  addExtension(
    {
      id,
      kind: "widget",
      attachTo: { slot, ...(order === undefined ? {} : { order }) },
      config: providerId === undefined ? {} : { providerId },
      component,
    },
    "card",
    "registerCard",
  );
}

/**
 * A section on host or service detail pages (`entity:<entity>/sections`). The entity pages are
 * open: any module attaches a section by its id, with its own heading, and the pages render
 * whatever is attached, in order.
 */
export function registerEntityFragment(registration: EntityFragmentRegistration): void {
  parseId(registration.id, "registerEntityFragment", "section");
  if (registration.entity !== "host" && registration.entity !== "service") {
    throw new RegistrationError(
      "MISSING_FIELD",
      `registerEntityFragment(${registration.id}): "entity" must be "host" | "service"`,
    );
  }
  requireComponent(registration.component, `registerEntityFragment(${registration.id})`);
  if (extensions.has(registration.id)) {
    throw new RegistrationError(
      "DUPLICATE_ID",
      `registerEntityFragment: duplicate fragment id "${registration.id}"`,
    );
  }
  const { id, entity, title, section, order, component } = registration;
  addExtension(
    {
      id,
      kind: "entity-section",
      attachTo: { slot: entitySectionsSlot(entity), ...(order === undefined ? {} : { order }) },
      config: section === undefined ? { title } : { section, title },
      component,
    },
    "section",
    "registerEntityFragment",
  );
}

/**
 * A typed handle to a pill slot that is already declared (core's `app/topbar.status`), whose
 * pills render with payload `P`. Throws `UNKNOWN_SLOT` if no pill slot has that id.
 */
export function summarySlot<P>(slotId: string): SummarySlot<P> {
  if (slots.get(slotId)?.accepts !== "pill") {
    throw new RegistrationError("UNKNOWN_SLOT", `summarySlot: "${slotId}" is not a declared pill slot`);
  }
  return { slotId };
}

/**
 * Declare a pill slot whose pills render with payload `P` (hosted by `core` unless `module` is
 * given). A primitive for tests: core's pill slot is declared with the shell's slots, so
 * modules take a handle to it with {@link summarySlot}.
 */
export function defineSummarySlot<P>(options: { slotId: string; module?: string }): SummarySlot<P> {
  requireString(options.slotId, "slotId", "defineSummarySlot");
  defineSlot({ id: options.slotId, accepts: "pill", module: options.module ?? "core" });
  return { slotId: options.slotId };
}

/** A summary pill in a declared summary slot (the top bar's status slot). */
export function registerSummaryFragment<P>(
  slot: SummarySlot<P>,
  registration: SummaryFragmentRegistration<NoInfer<P>>,
): void {
  if (!slot || slots.get(slot.slotId)?.accepts !== "pill") {
    throw new RegistrationError(
      "UNKNOWN_SLOT",
      `registerSummaryFragment: slot "${slot?.slotId}" is not a declared pill slot; take a handle to one with summarySlot(id)`,
    );
  }
  parseId(registration.id, "registerSummaryFragment", "pill");
  requireComponent(registration.component, `registerSummaryFragment(${registration.id})`);
  if (extensions.has(registration.id)) {
    throw new RegistrationError(
      "DUPLICATE_ID",
      `registerSummaryFragment: duplicate fragment id "${registration.id}" in slot "${slot.slotId}"`,
    );
  }
  const { id, order, component } = registration;
  addExtension(
    { id, kind: "pill", attachTo: { slot: slot.slotId, ...(order === undefined ? {} : { order }) }, component },
    "pill",
    "registerSummaryFragment",
  );
}

// ---------------------------------------------------------------------------
// Blueprint views: each slot's extensions in the shape its blueprint registered.
// ---------------------------------------------------------------------------

/** A view with the extension's order, left out when it is the default. */
function withOrder<T extends object>(view: T, extension: Extension): T & { order?: number } {
  return extension.attachTo.order === DEFAULT_ORDER ? view : { ...view, order: extension.attachTo.order };
}

/** A widget type: `<module>/<name>`. */
const WIDGET_TYPE = /^([a-z][a-z0-9-]*)\/[a-z0-9][a-z0-9-]*$/;

/**
 * Register the component a widget type renders with, so config pages' widgets of that type
 * render. The type is namespaced to its module (`<module>/<name>`); a type registers once.
 */
export function registerWidgetType(registration: WidgetTypeRegistration): void {
  const context = `registerWidgetType(${String(registration.type)})`;
  const match = typeof registration.type === "string" ? WIDGET_TYPE.exec(registration.type) : null;
  if (match === null || match[1] !== registration.module) {
    throw new RegistrationError("INVALID_ID", `${context}: type must have the form ${String(registration.module)}/<name>`);
  }
  requireComponent(registration.component, context);
  if (widgetTypes.has(registration.type)) throw new RegistrationError("DUPLICATE_ID", `${context}: widget type already registered`);
  widgetTypes.set(registration.type, Object.freeze({ ...registration }));
  notify();
}

/** The registered widget type, or none. */
export function getWidgetType(type: string): WidgetTypeRegistration | undefined {
  return widgetTypes.get(type);
}

/** Whether a widget type is registered. */
export function hasWidgetType(type: string): boolean {
  return widgetTypes.has(type);
}

export function getPages(): readonly PageRegistration[] {
  return getExtensions(ROUTES_SLOT).map((extension) => {
    const page = extension.config as Omit<PageRegistration, "id" | "component" | "order" | "navOrder">;
    // The nav entry's order, when it differs from the route's (the fallback nav sorts by it).
    const nav = extensions.get(`nav:${extension.id.slice("page:".length)}`);
    const navOrder = nav !== undefined && nav.attachTo.order !== extension.attachTo.order ? { navOrder: nav.attachTo.order } : {};
    return withOrder<PageRegistration>({ id: extension.id, ...page, ...navOrder, component: extension.component! }, extension);
  });
}

/**
 * The widget cards registered to `slot`, from the registry alone. A slot host renders what
 * the UI manifest places instead (`useManifestSlot` / `placeExtensions`, which fall back to the
 * registry when the manifest cannot be read); this registry-only view serves only that
 * fallback and older callers.
 */
export function getCards(slot: string): readonly CardRegistration<unknown>[] {
  return getExtensions(slot)
    .filter((extension) => extension.kind === "widget")
    .map((extension) =>
      withOrder(
        {
          // Identity, slot and order come from the extension; only known config fields project.
          id: extension.id,
          slot,
          ...(typeof extension.config.providerId === "string" ? { providerId: extension.config.providerId } : {}),
          component: extension.component as CardRegistration<unknown>["component"],
        },
        extension,
      ),
    );
}

/** The section an entity fragment renders in: the one it names, else `<module>.<name>` from its id. */
export function fragmentSection(fragment: Pick<EntityFragmentRegistration, "id" | "section">): string {
  return entitySectionName(fragment.id, fragment)!;
}

/** An entity-section extension in the shape `registerEntityFragment` registered it. */
function toEntityFragment(entity: "host" | "service", extension: Extension): EntityFragmentRegistration {
  const named = extension.config.section as string | undefined;
  return withOrder<EntityFragmentRegistration>(
    {
      id: extension.id,
      entity,
      title: extension.config.title as string,
      ...(named === undefined ? {} : { section: named }),
      component: extension.component as EntityFragmentRegistration["component"],
    },
    extension,
  );
}

/** The fragments attached to an entity page, by order then id; only `section`'s when given. */
export function getEntityFragments(
  entity: "host" | "service",
  section?: string,
): readonly EntityFragmentRegistration[] {
  return getExtensions(entitySectionsSlot(entity))
    .map((extension) => toEntityFragment(entity, extension))
    .filter((fragment) => section === undefined || fragmentSection(fragment) === section);
}

/**
 * Group an entity page's placed extensions (its `entity:<entity>/sections` slot, in render
 * order) into sections: in the order of each section's first fragment, headed by that
 * fragment's title. Anything not an entity section, or without a usable section config, is
 * ignored. A module that is off has no
 * extensions in the UI manifest, so its sections are simply absent: no heading, no placeholder.
 */
export function groupEntitySections(entity: "host" | "service", placed: readonly Extension[]): readonly EntitySection[] {
  const sections = new Map<string, { section: string; title: string; fragments: EntityFragmentRegistration[] }>();
  for (const extension of placed) {
    // A placed config that is not a usable section (no title) cannot head one.
    if (extension.kind !== "entity-section" || entitySectionProblem(extension.config, "entity section") !== null) continue;
    const fragment = toEntityFragment(entity, extension);
    const name = fragmentSection(fragment);
    const section = sections.get(name);
    if (section === undefined) sections.set(name, { section: name, title: fragment.title, fragments: [fragment] });
    else section.fragments.push(fragment);
  }
  return [...sections.values()];
}

/**
 * An entity page's sections from the registry alone: every attached fragment grouped by
 * section ({@link groupEntitySections}).
 */
export function getEntitySections(entity: "host" | "service"): readonly EntitySection[] {
  return groupEntitySections(entity, getExtensions(entitySectionsSlot(entity)));
}

/**
 * Sections on one entity page that share a heading. Each section is a landmark named by its
 * title, so two with the same title give screen readers two identically named regions.
 * Discovery reports them in development; rendering is unchanged.
 */
export function getDuplicateEntitySectionTitles(): readonly { entity: "host" | "service"; title: string; sections: readonly string[] }[] {
  const duplicates: { entity: "host" | "service"; title: string; sections: string[] }[] = [];
  for (const entity of ["host", "service"] as const) {
    const byTitle = new Map<string, string[]>();
    for (const { section, title } of getEntitySections(entity)) byTitle.set(title, [...(byTitle.get(title) ?? []), section]);
    for (const [title, sections] of byTitle) if (sections.length > 1) duplicates.push({ entity, title, sections });
  }
  return duplicates;
}
