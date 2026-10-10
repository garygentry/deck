import { defineServerModule, isSafeHref, type ConfigRuleFinding, type JsonObject, type ModuleManifest } from "@deck/module-sdk";

import { LinkProvider, type LinkDescriptor } from "./index.js";

/**
 * The `link` data source: a host or service binding `{ href, label?, icon? }` becomes a
 * static provider serving that descriptor. It is never polled. An `href` must be an http(s)
 * URL or an absolute path in deck (`isSafeHref`): config validation reports any other
 * (`javascript:`, `data:`, a relative path) as LINK_HREF_UNSAFE, and such a binding registers
 * no provider, so its href is never served.
 */
export const LINK_MANIFEST: ModuleManifest = {
  id: "link",
  version: "1.0.0",
  deckApi: "^0.1",
  providerKinds: [
    {
      kind: "link",
      static: true,
      bindable: true,
      statusCapable: false,
      findings: [
        {
          code: "LINK_HREF_UNSAFE",
          severity: "error",
          summary: "A link binding's href is neither an http(s) URL nor an absolute path in deck.",
          fix: "Give a full http:// or https:// URL, or a path in deck that starts with a single /.",
        },
      ],
    },
  ],
};

/** What config validation reports for one link binding. Pure. */
function validateBinding(binding: JsonObject): ConfigRuleFinding[] {
  const { href } = binding;
  if (typeof href !== "string" || isSafeHref(href)) return [];
  return [{
    code: "LINK_HREF_UNSAFE",
    path: "/href",
    message: "href is not an http(s) URL or an absolute path in deck, so the link is not served.",
    hint: "Use https://… or /path; javascript:, data: and other schemes are refused.",
  }];
}

export const linkModule = defineServerModule(LINK_MANIFEST, () => {}, {
  kinds: {
    link: {
      validateBinding,
      binding: ({ id, owner, value }) => {
        if (typeof value.href !== "string" || !isSafeHref(value.href)) return [];
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
