import { lazy } from "react";

// The page loads on first visit; the header pill stays eager.
export const LlmUsagePage = lazy(() =>
  import("./LlmUsagePage.js").then((m) => ({ default: m.LlmUsagePage })),
);
