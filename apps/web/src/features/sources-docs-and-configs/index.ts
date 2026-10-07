// Eager registration entry point for the sources browsing feature (07 §3, 06 §4).
// Import-side-effect only — exports nothing. Discovered by
// `import.meta.glob("../features/*/index.ts")`; no shell edit (SC-09). Registration errors are
// intentionally uncaught so eager discovery fails loudly (mirrors `governed-actions/index.ts`).

import { registerEntityFragment, registerPage } from "../../registry/registry.js";
import { ConfigsPage, DocsPage, OwnedConfigsFragment } from "./pages.js";

// --- Docs page (06 §4). ---
registerPage({
  id: "docs",
  path: "/docs",
  label: "Docs",
  icon: "book-open",
  group: "Knowledge",
  component: DocsPage,
});

// --- Configs page (REQ-CFG-01). Page id is "configs-view" ON PURPOSE: it must NOT collide with
//     the entity SLOT id "configs" (a distinct namespace, INVENTORY_SLOTS). ---
registerPage({
  id: "configs-view",
  path: "/configs",
  label: "Configs",
  icon: "file-cog",
  group: "Knowledge",
  component: ConfigsPage,
});

// --- Owned-configs fragment, attached to the pre-existing frozen "configs" slot on BOTH the host
//     and service detail routes (REQ-FRAG-01). No edit to EntitySlots.tsx or the detail routes —
//     the slot already exists in INVENTORY_SLOTS (CON-02/SC-09). Two distinct fragment ids are
//     required because registerEntityFragment keys uniqueness by id; the same component serves
//     both entity kinds and branches on entity.entity internally. ---
registerEntityFragment({
  id: "owned-configs-host",
  entity: "host",
  slot: "configs",
  component: OwnedConfigsFragment,
});
registerEntityFragment({
  id: "owned-configs-service",
  entity: "service",
  slot: "configs",
  component: OwnedConfigsFragment,
});
