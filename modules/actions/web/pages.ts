import { lazy } from "react";

// The actions console loads on first visit.
export const ActionsPage = lazy(() =>
  import("./ActionsPage.js").then((m) => ({ default: m.ActionsPage })),
);
