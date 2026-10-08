import type { SlotDecl, WidgetTypeDecl } from "@deck/module-sdk";

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

/**
 * The kernel's own widget types, hosted by `core`, which config pages (`ui.pages`) may use
 * like any module's: the server composes their option schemas into config validation and
 * lists them in the UI manifest, and the web registers a component for each. Data only.
 * - `core/json`: the widget's selected value, as formatted JSON (`wrap` soft-wraps long lines).
 */
export const CORE_WIDGET_TYPES: readonly WidgetTypeDecl[] = [
  {
    type: "core/json",
    optionsSchema: {
      type: "object",
      additionalProperties: false,
      properties: { wrap: { type: "boolean", description: "Soft-wrap long lines instead of scrolling." } },
    },
    component: "JsonWidget",
  },
];
