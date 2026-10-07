import { defineSlot, registerExtension } from "../registry/registry.js";
import { ThemeMenu } from "./ThemeMenu.js";

/** The top bar's controls slot (`app/topbar.actions`), hosted by the shell. */
export const TOPBAR_ACTIONS_SLOT = defineSlot({ id: "app/topbar.actions", accepts: "action", module: "core" }).id;

// The theme picker is the shell's own control, placed like any extension so config can move it.
registerExtension({ id: "action:core/theme-menu", kind: "action", attachTo: { slot: TOPBAR_ACTIONS_SLOT }, component: ThemeMenu });
