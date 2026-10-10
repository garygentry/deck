import { SOURCES_UI } from "@deck/contract/modules/sources";
import { defineWebModule } from "@deck/module-sdk";
import type { ComponentType } from "react";

import type { EntityFragmentRegistration } from "@/registry/registry.js";
import { registerWebModule } from "@/registry/web-module.js";
import { ConfigsPage, DocsPage, OwnedConfigsFragment } from "./pages.js";

// The Docs and Configs pages and the owned-configs section on the host and service detail
// pages. Their paths, titles, icons, nav group and the section's slots, order and heading are
// the sources module's manifest data; the UI manifest decides at runtime what renders. The
// entity-section slots are core's, declared by the registry itself.
export const sourcesWebModule = defineWebModule(SOURCES_UI, {
  // The section keeps the entity-section slots' component contract.
  components: { DocsPage, ConfigsPage, OwnedConfigsFragment } satisfies {
    DocsPage: ComponentType;
    ConfigsPage: ComponentType;
    OwnedConfigsFragment: EntityFragmentRegistration["component"];
  },
});

registerWebModule(sourcesWebModule);
