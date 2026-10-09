import type {
  ExtensionId,
  JsonObject,
  PageDecl,
  UiFinding,
  UiLayoutSection,
  UiWidgetSection,
  UiManifest,
  UiPageLayout,
  UiProvider,
  UiSlot,
  UiWidgetInstance,
  UiWidgetType,
} from "@deck/module-sdk";

import { modulePageWidgetId, UI_CONFIG_MODULE } from "@deck/module-sdk";

import { compileSelect, type CompiledSelect } from "@deck/schema/select";

import type { ProviderSelects } from "../providers/registry.js";
import { isRecord } from "./validate.js";

/** The component a config page renders with, in the core web module's table. */
export const CONFIG_PAGE_COMPONENT = "ConfigPage";

/** A config page as the `ui.pages` config declares it (validated; read leniently anyway). */
export interface ConfigPage {
  /** The page's name: its id is `page:ui/<id>`. */
  id: string;
  path: string;
  title: string;
  icon?: string;
  nav?: { group: string; label?: string; order?: number };
  sections: ConfigSection[];
}

export interface ConfigSection {
  title: string;
  columns?: number;
  widgets: ConfigWidget[];
}

export interface ConfigWidget {
  id?: string;
  type: string;
  title?: string;
  source?: string | { kind: string };
  select?: string;
  options?: JsonObject;
  span?: number;
  rows?: number;
}

/** A config page's extension ids. */
export function configPageIds(page: Pick<ConfigPage, "id">): { page: ExtensionId; nav: ExtensionId } {
  return { page: `page:${UI_CONFIG_MODULE}/${page.id}`, nav: `nav:${UI_CONFIG_MODULE}/${page.id}` };
}

/**
 * A widget's extension id: `widget:ui/<page>.<id>` from its `id`; without one, positional
 * (`widget:ui/<page>.s<N>w<M>`, 1-based), which changes when sections or widgets move.
 */
export function configWidgetId(page: string, widget: Pick<ConfigWidget, "id">, section: number, index: number): { id: ExtensionId; positional: boolean } {
  return widget.id === undefined
    ? { id: `widget:${UI_CONFIG_MODULE}/${page}.s${section + 1}w${index + 1}`, positional: true }
    : { id: `widget:${UI_CONFIG_MODULE}/${page}.${widget.id}`, positional: false };
}

/** Every widget id on a config page, with whether it is positional. */
export function configWidgetIds(page: ConfigPage): Array<{ id: ExtensionId; positional: boolean }> {
  return page.sections.flatMap((section, sectionIndex) =>
    section.widgets.map((widget, index) => configWidgetId(page.id, widget, sectionIndex, index)),
  );
}

/**
 * A config page's layout: its sections in order, each widget with its source resolved
 * against the registered providers and its span clamped to the section's columns. Widgets an
 * override switches off (`enabled(id) === false`) are left out, and a section left with none
 * is dropped. Problems are findings; none stops the page from rendering.
 */
export function buildLayout(
  page: ConfigPage,
  context: {
    providers: readonly UiProvider[];
    widgetTypes: readonly UiWidgetType[];
    enabled: (id: ExtensionId) => boolean;
    findings: UiFinding[];
  },
): UiPageLayout {
  const sections: UiLayoutSection[] = [];
  page.sections.forEach((section, sectionIndex) => {
    const columns = clamp(section.columns ?? 1, 1, 4) as UiWidgetSection["columns"];
    const widgets: UiWidgetInstance[] = [];
    section.widgets.forEach((widget, index) => {
      const { id } = configWidgetId(page.id, widget, sectionIndex, index);
      if (!context.enabled(id)) return;
      const span = clamp(widget.span ?? 1, 1, 4);
      if (span > columns) {
        context.findings.push({ code: "UI_WIDGET_SPAN", severity: "warning", message: `widget "${id}" spans ${span} columns; its section has ${columns}, so it spans ${columns}`, id });
      }
      // A type no enabled module provides renders as unavailable: no data is read or projected for it.
      const typeProblem = context.widgetTypes.some((type) => type.type === widget.type)
        ? undefined
        : `No enabled module provides the widget type "${widget.type}".`;
      const { source, problem } = typeProblem === undefined ? resolveSource(id, widget, context) : { source: null, problem: undefined };
      widgets.push({
        id,
        type: widget.type,
        ...(widget.title === undefined ? {} : { title: widget.title }),
        source,
        ...(problem === undefined ? {} : { sourceProblem: problem }),
        ...(typeProblem === undefined ? {} : { typeProblem }),
        ...(widget.select === undefined || typeProblem !== undefined ? {} : { select: widget.select, projection: id }),
        options: widget.options ?? {},
        span: Math.min(span, columns) as UiWidgetInstance["span"],
        rows: clamp(widget.rows ?? 1, 1, 6),
      });
    });
    if (widgets.length > 0) sections.push({ title: section.title, columns, widgets });
  });
  return { sections };
}

/**
 * The provider a widget reads: its `source` id, or the first provider of its `source` kind
 * by id (as the web's `useProvider({ kind })` picks); `null` with a finding and a short
 * problem for the widget to show when that names no registered provider, or one of a kind the
 * widget type cannot render.
 */
function resolveSource(
  id: ExtensionId,
  widget: ConfigWidget,
  context: { providers: readonly UiProvider[]; widgetTypes: readonly UiWidgetType[]; findings: UiFinding[] },
): { source: UiProvider | null; problem?: string } {
  if (widget.source === undefined) return { source: null };
  const wanted = widget.source;
  const provider =
    typeof wanted === "string"
      ? context.providers.find((candidate) => candidate.id === wanted)
      : [...context.providers].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).find((candidate) => candidate.kind === wanted.kind);
  if (provider === undefined) {
    const named = typeof wanted === "string" ? `provider "${wanted}"` : `a provider of kind "${wanted.kind}"`;
    context.findings.push({ code: "UI_WIDGET_SOURCE_UNKNOWN", severity: "warning", message: `widget "${id}" reads ${named}, which is not registered`, id });
    return { source: null, problem: `It reads ${named}, which is not configured.` };
  }
  const sources = context.widgetTypes.find((type) => type.type === widget.type)?.sources;
  if (sources !== undefined && !sources.includes(provider.kind)) {
    context.findings.push({
      code: "UI_WIDGET_SOURCE_KIND",
      severity: "warning",
      message: `widget "${id}" reads provider "${provider.id}" of kind "${provider.kind}", which widget type "${widget.type}" cannot render (it renders ${sources.join(", ")})`,
      id,
    });
    return { source: null, problem: `It cannot render provider "${provider.id}" (kind ${provider.kind}).` };
  }
  return { source: { id: provider.id, kind: provider.kind } };
}

/**
 * The selects a UI manifest's config pages need, by provider id, compiled: what the provider
 * registry evaluates into each envelope's `projections` (`setProjections`). Pure: rebuilt with
 * every manifest, so a swapped manifest swaps its selects too. A widget whose type is
 * unavailable has no projection, so nothing is selected for it.
 */
export function deriveProjections(manifest: Pick<UiManifest, "pages">): Map<string, ProviderSelects> {
  const selects = new Map<string, Map<string, CompiledSelect>>();
  // Each expression is parsed once, however many widgets share it.
  const compiled = new Map<string, CompiledSelect>();
  for (const page of manifest.pages) {
    for (const section of page.layout?.sections ?? []) {
      if (!("widgets" in section)) continue;
      for (const widget of section.widgets) {
        if (widget.source === null || widget.select === undefined || widget.projection === undefined) continue;
        const forProvider = selects.get(widget.source.id) ?? new Map<string, CompiledSelect>();
        let select = compiled.get(widget.select);
        if (select === undefined) {
          select = compileSelect(widget.select);
          compiled.set(widget.select, select);
        }
        forProvider.set(widget.projection, select);
        selects.set(widget.source.id, forProvider);
      }
    }
  }
  return selects;
}

/**
 * The config pages of a config document (`ui.pages`). The config has been validated, so a
 * malformed entry cannot occur; one is dropped anyway rather than trusted.
 */
export function configPagesOf(config: unknown): ConfigPage[] {
  const pages = (config as { ui?: { pages?: unknown } } | null)?.ui?.pages;
  if (!Array.isArray(pages)) return [];
  return pages.filter((page): page is ConfigPage =>
    isRecord(page)
    && typeof page.id === "string"
    && typeof page.path === "string"
    && typeof page.title === "string"
    && Array.isArray(page.sections)
    && page.sections.every((section) => isRecord(section) && typeof section.title === "string" && Array.isArray(section.widgets)
      && section.widgets.every((widget) => isRecord(widget) && typeof widget.type === "string")),
  );
}

function clamp(value: number, min: number, max: number): number {
  return Number.isInteger(value) ? Math.min(Math.max(value, min), max) : min;
}

/** Every widget id on a module page's default dashboard (`layout`). */
export function modulePageWidgetIds(page: Pick<PageDecl, "id" | "layout">): ExtensionId[] {
  return (page.layout?.sections ?? []).flatMap((section) =>
    "widgets" in section ? section.widgets.flatMap((widget) => modulePageWidgetId(page.id, widget.id) ?? []) : [],
  );
}

/**
 * A module page's default dashboard (`contributes.pages[].layout`, validated with its manifest):
 * a slot section while an enabled module hosts the slot as a `widget` slot, and each widget of
 * a widget section unless an override switches it off. A type no enabled module provides
 * renders as unavailable, as on a config page. Its widgets read no provider and take no options.
 */
export function buildModuleLayout(
  page: Pick<PageDecl, "id" | "layout">,
  context: {
    slots: ReadonlyMap<string, UiSlot>;
    knownSlots: ReadonlySet<string>;
    widgetTypes: readonly UiWidgetType[];
    enabled: (id: ExtensionId) => boolean;
    findings: UiFinding[];
  },
): UiPageLayout {
  const sections: UiLayoutSection[] = [];
  for (const section of page.layout?.sections ?? []) {
    if ("slot" in section) {
      const slot = context.slots.get(section.slot);
      if (slot?.accepts === "widget") sections.push({ slot: section.slot });
      else if (!context.knownSlots.has(section.slot)) {
        context.findings.push({ code: "UI_UNKNOWN_SLOT", severity: "warning", message: `page "${page.id}" lays out unknown slot "${section.slot}"`, id: page.id, slot: section.slot });
      }
      continue;
    }
    const widgets: UiWidgetInstance[] = [];
    for (const widget of section.widgets) {
      const id = modulePageWidgetId(page.id, widget.id);
      if (id === null || !context.enabled(id)) continue;
      const provided = context.widgetTypes.some((type) => type.type === widget.type);
      widgets.push({
        id,
        type: widget.type,
        source: null,
        ...(provided ? {} : { typeProblem: `No enabled module provides the widget type "${widget.type}".` }),
        options: {},
        span: 1,
        rows: 1,
      });
    }
    if (widgets.length > 0) sections.push({ columns: 1, widgets });
  }
  return { sections };
}
