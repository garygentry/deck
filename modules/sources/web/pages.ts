import { lazy } from "react";

// The source browser pulls in markdown-it, DOMPurify and highlight.js, so its
// pages load on first visit instead of shipping in the main bundle.
const load = () => import("./SourceBrowserPage.js");

export const DocsPage = lazy(() => load().then((m) => ({ default: m.DocsPage })));
export const ConfigsPage = lazy(() => load().then((m) => ({ default: m.ConfigsPage })));

// Renders only inside the (lazy) host/service detail pages.
export const OwnedConfigsFragment = lazy(() =>
  import("./OwnedConfigsFragment.js").then((m) => ({ default: m.OwnedConfigsFragment })),
);
