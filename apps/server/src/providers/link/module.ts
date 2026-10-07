import { defineServerModule, type ModuleManifest } from "@deck/module-sdk";

import { LinkProvider, type LinkDescriptor } from "./index.js";

/**
 * The `link` data source: a host or service binding `{ href, label?, icon? }` becomes a
 * static provider serving that descriptor. It is never polled.
 */
export const LINK_MANIFEST: ModuleManifest = {
  id: "link",
  version: "1.0.0",
  deckApi: "^0.1",
  providerKinds: [{ kind: "link", static: true, bindable: true, statusCapable: false }],
};

export const linkModule = defineServerModule(LINK_MANIFEST, () => {}, {
  kinds: {
    link: {
      binding: ({ id, owner, value }) => {
        if (typeof value.href !== "string") return [];
        const descriptor: LinkDescriptor = {
          label: typeof value.label === "string" ? value.label : owner,
          href: value.href,
          ...(typeof value.icon === "string" ? { icon: value.icon } : {}),
        };
        return [{ provider: new LinkProvider(id, descriptor) }];
      },
    },
  },
});
