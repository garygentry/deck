import { lazy } from "react";

// The monitoring page loads on first visit; the header summaries stay eager.
export const MonitoringPage = lazy(() =>
  import("./MonitoringPage.js").then((m) => ({ default: m.MonitoringPage })),
);
