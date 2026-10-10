import { lazy } from "react";
import { registerPage } from "../../registry/registry.js";

// The component workbench is a development tool: it is never registered in a
// production build, and the dynamic import below is dropped with the branch, so
// none of its code ships.
// Its module id (`ui-workbench`) is one no server lists, so the router routes it
// whatever the UI manifest says (a listed module's pages route only as the manifest does).
if (import.meta.env.DEV) {
  registerPage({
    id: "page:ui-workbench/overview",
    path: "/_ui",
    label: "UI workbench",
    component: lazy(() => import("./UiWorkbench.js").then((m) => ({ default: m.UiWorkbench }))),
    nav: false,
  });
}
