import { registerExtension } from "../registry/registry.js";
import { ThemeMenu } from "./ThemeMenu.js";

/** The top bar's controls slot (`app/topbar.actions`), which the registry declares with every core slot. */
export const TOPBAR_ACTIONS_SLOT = "app/topbar.actions";

// The theme picker is the shell's own control, placed like any extension so config can move it.
registerExtension({ id: "action:core/theme-menu", kind: "action", attachTo: { slot: TOPBAR_ACTIONS_SLOT }, component: ThemeMenu });
