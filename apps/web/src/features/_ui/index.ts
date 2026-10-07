import { lazy } from "react";
import { registerPage } from "../../registry/registry.js";

// The component workbench is a development tool: it is never registered in a
// production build, and the dynamic import below is dropped with the branch, so
// none of its code ships.
if (import.meta.env.DEV) {
  registerPage({
    id: "page:core/ui-workbench",
    path: "/_ui",
    label: "UI workbench",
    component: lazy(() => import("./UiWorkbench.js").then((m) => ({ default: m.UiWorkbench }))),
    nav: false,
  });
}
