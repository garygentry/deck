import type { ComposedConfig } from "../../compose/compose.js";
import { finding, type Finding } from "../../findings.js";
import type { DeckConfigDocument, ValidateLayer } from "../../types.js";

/**
 * Report a host's or service's presentation link whose `href` the composition's `isSafeHref`
 * check refuses (ENTITY_LINK_HREF_UNSAFE, an error), on the merged document: it must be an
 * http(s) URL or an absolute path in deck, never `javascript:`, `data:` or `//host`. The web
 * renders these links as anchors. Without the check (the library's default composition), links
 * are not checked; deck composes with `@deck/module-sdk`'s `isSafeHref`.
 */
export function entityLinks(doc: DeckConfigDocument, composed: Pick<ComposedConfig, "isSafeHref">, layer: ValidateLayer): Finding[] {
  const safe = composed.isSafeHref;
  if (safe === undefined || layer !== "merged") return [];
  const findings: Finding[] = [];
  const inspect = (links: readonly { href: string }[] | undefined, path: string): void => {
    for (const [index, link] of (links ?? []).entries()) {
      if (safe(link.href)) continue;
      findings.push(finding(
        "ENTITY_LINK_HREF_UNSAFE",
        `${path}/links/${index}/href`,
        "link href is not an http(s) URL or an absolute path in deck, so it is not shown as a link",
        "Use https://… or /path; javascript:, data:, //host and relative links are refused.",
      ));
    }
  };
  for (const [index, host] of (doc.hosts ?? []).entries()) inspect(host.links, `/hosts/${index}`);
  for (const [index, service] of (doc.services ?? []).entries()) inspect(service.links, `/services/${index}`);
  return findings;
}
