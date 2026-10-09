import type { JsonSchema, SlotDecl, WidgetTypeDecl } from "@deck/module-sdk";
import { CORE_WIDGET_TYPE_SCHEMAS, type CoreWidgetType } from "./widgets.js";

/**
 * The kernel-reserved slots, hosted by `core`: the shell's (`app/…`) and the entity detail
 * pages' (`entity:<entity>/…`). No module may declare a slot in these namespaces. The server's
 * UI manifest lists them as core's, and the web registry declares every one of them when it
 * loads, so a module can attach to any of them whatever imports it first. It is data only (no
 * runtime imports), so the browser bundle can load it.
 */
export const SHELL_SLOTS: readonly SlotDecl[] = [
  { id: "app/nav", accepts: "nav" },
  { id: "app/routes", accepts: "page" },
  { id: "app/topbar.actions", accepts: "action" },
  { id: "app/topbar.status", accepts: "pill" },
  { id: "entity:host/sections", accepts: "entity-section" },
  { id: "entity:service/sections", accepts: "entity-section" },
];

/** Each core widget type's component, in the core web module's table. */
const CORE_WIDGET_COMPONENTS: Readonly<Record<CoreWidgetType, string>> = {
  "core/stat": "StatWidget",
  "core/stat-grid": "StatGridWidget",
  "core/meter": "MeterWidget",
  "core/key-value": "KeyValueWidget",
  "core/list": "ListWidget",
  "core/table": "TableWidget",
  "core/status-grid": "StatusGridWidget",
  "core/link-tiles": "LinkTilesWidget",
  "core/markdown": "MarkdownWidget",
  "core/health-pills": "HealthPillsWidget",
  "core/json": "JsonWidget",
};

/**
 * The kernel's own widget types, hosted by `core`, which config pages (`ui.pages`) may use
 * like any module's: the server lists them in the UI manifest and the web registers a component
 * for each. Their option schemas are the ones config validation composes (the schema library's
 * own copy, kept equal to these by tests). See `./widgets.ts` for what each type shows.
 */
export const CORE_WIDGET_TYPES: readonly WidgetTypeDecl[] = CORE_WIDGET_TYPE_SCHEMAS.map(({ type, optionsSchema }) => ({
  type,
  optionsSchema: optionsSchema as unknown as JsonSchema,
  component: CORE_WIDGET_COMPONENTS[type],
}));
