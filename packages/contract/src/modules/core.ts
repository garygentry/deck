import type { SlotDecl } from "@deck/module-sdk";

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
