// Eager registration entry point for the sources browsing feature.
// Import-side-effect only — exports nothing. Discovered by
// `import.meta.glob("../features/*/index.ts")`; no shell edit. Registration errors are
// intentionally uncaught so eager discovery fails loudly (mirrors `governed-actions/index.ts`).

import { registerEntityFragment, registerPage } from "../../registry/registry.js";
import { ConfigsPage, DocsPage, OwnedConfigsFragment } from "./pages.js";

// --- Docs page. ---
registerPage({
  id: "page:sources/docs",
  path: "/docs",
  label: "Docs",
  icon: "book-open",
  group: "Knowledge",
  component: DocsPage,
});

// --- Configs page. ---
registerPage({
  id: "page:sources/configs",
  path: "/configs",
  label: "Configs",
  icon: "file-cog",
  group: "Knowledge",
  component: ConfigsPage,
});

// --- Owned-configs section on BOTH the host and service detail pages, attached
//     by id after drift's findings. Two distinct ids are required because extension ids are
//     unique; the same component serves both entity kinds and branches on entity.entity. ---
registerEntityFragment({
  id: "section:sources/host-configs",
  entity: "host",
  section: "configs",
  title: "Configs",
  order: 20,
  component: OwnedConfigsFragment,
});
registerEntityFragment({
  id: "section:sources/service-configs",
  entity: "service",
  section: "configs",
  title: "Configs",
  order: 20,
  component: OwnedConfigsFragment,
});
