import { serviceRef, type NavDecl, type UiFinding } from "@deck/module-sdk";

import type { ModuleHost } from "../modules/host.js";
import type { ConfigPage } from "./config-pages.js";

/**
 * Pages a module contributes at runtime rather than in its manifest (a sidecar's described
 * widgets, say): config pages in the module's own namespace (`page:<module>/<id>`), nav entries
 * (`nav:<module>/…`, to those pages or external hrefs) and findings about them. They change
 * while deck runs; the UI manifest is resolved again on each change.
 */
export interface RuntimePages {
  pages: ConfigPage[];
  nav: RuntimeNavEntry[];
  findings: UiFinding[];
}

/**
 * A runtime nav entry. `ownerPage` names the runtime page it belongs with (an external link a
 * sidecar describes beside its page): it is listed only while that page is routed.
 */
export type RuntimeNavEntry = NavDecl & { module: string; ownerPage?: string };

/** What a module offers under {@link RUNTIME_PAGES}. */
export interface RuntimePageSource {
  /** Its pages, nav entries and findings now. */
  current(): RuntimePages;
  /** Hear of each change; the returned function stops it. */
  subscribe(listener: () => void): () => void;
}

/** The kernel service a built-in module offers its runtime pages under. */
export const RUNTIME_PAGES = serviceRef<RuntimePageSource>("ui/runtime-pages");

/** One module's runtime page source. */
export interface RuntimePageOffer {
  module: string;
  source: RuntimePageSource;
}

/** The runtime page sources the host's built-in modules offer, in publish order; another module's offer is ignored. */
export function runtimePageSources(host: Pick<ModuleHost, "serviceOffers">): RuntimePageOffer[] {
  return host
    .serviceOffers(RUNTIME_PAGES.name)
    .filter((offer) => offer.builtin)
    .map((offer) => ({ module: offer.module, source: offer.impl as RuntimePageSource }));
}

/**
 * Every source's pages and nav entries, each kept only in its own module's namespace, and
 * their findings. Every runtime page's widgets render links under the `external` link policy.
 * A source that throws contributes nothing this time.
 */
export function collectRuntimePages(offers: readonly RuntimePageOffer[]): RuntimePages {
  const result: RuntimePages = { pages: [], nav: [], findings: [] };
  for (const { module, source } of offers) {
    let current: RuntimePages;
    try {
      current = source.current();
    } catch {
      continue;
    }
    // Runtime contributions come from outside deck (a sidecar): their links are external only.
    result.pages.push(...current.pages.filter((page) => page.module === module).map((page) => ({ ...page, linkPolicy: "external" as const })));
    result.nav.push(...current.nav.filter((entry) => entry.module === module && entry.id.startsWith(`nav:${module}/`)));
    result.findings.push(...current.findings);
  }
  return result;
}
