import { PORTAL_UI } from "@deck/contract/modules/portal";
import { defineServerModule, type JsonSchema, type ModuleManifest } from "@deck/module-sdk";

import type { PortalModuleConfig } from "./config.generated.js";
import schema from "./schema.json" with { type: "json" };

/** The `ID_DUPLICATE` message for a group or subgroup id repeated anywhere in the tree. */
const GROUP_ID_REPEATED = "Group or subgroup id {key} is used more than once across the groups tree.";

/**
 * The portal module: the launch page, its `modules.portal.groups` layout and the topbar
 * endpoint pill.
 *
 * The groups are presentation, so the whole section is overlay-owned. Group and subgroup ids
 * share one namespace across the tree. Service and link items are keyed for the layer merge
 * only, so a group may repeat an item, as it always could. Every service item must name a
 * declared service. The portal has no server code of its own: it renders from `/api/config`
 * and the providers.
 */
export const PORTAL_MANIFEST: ModuleManifest = {
  // Identity and UI contributions are shared with the web half.
  ...PORTAL_UI,
  config: {
    schema: schema as unknown as JsonSchema,
    ownership: { "": "overlay" },
    identity: {
      groups: ["id"],
      "groups[].items": { service: ["host", "name"], link: ["href"], group: ["id"] },
      "groups[].items[].items": { service: ["host", "name"], link: ["href"] },
    },
    // Group and subgroup ids share one namespace. It also covers the subgroups' items, which
    // carry no id: that leaves every items row to the merge, so items may repeat.
    unique: [{ paths: ["groups[]", "groups[].items[]", "groups[].items[].items[]"], key: ["id"], message: GROUP_ID_REPEATED }],
    // Only service items carry a host; links and subgroups are skipped.
    references: [
      { path: "groups[].items[]", service: "name", at: "element" },
      { path: "groups[].items[].items[]", service: "name", at: "element" },
    ],
  },
};

export const portalModule = defineServerModule<PortalModuleConfig>(PORTAL_MANIFEST, () => {});
