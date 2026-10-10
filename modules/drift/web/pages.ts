import { lazy } from "react";

// The drift page and the findings fragment (it renders only on the lazy
// detail pages) load on first use; the header summary stays eager.
export const DriftPage = lazy(() =>
  import("./DriftPage.js").then((m) => ({ default: m.DriftPage })),
);
export const FindingsFragment = lazy(() =>
  import("./FindingsFragment.js").then((m) => ({ default: m.FindingsFragment })),
);
