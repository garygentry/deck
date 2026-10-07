import { finding, type Finding, type FindingCode } from "../../findings.js";
import { estateProviderIds } from "../../provider-ids.js";
import type { Located } from "../context.js";
import type { Rule } from "./types.js";

function duplicates(
  occurrences: readonly Located[],
  code: FindingCode,
  message: (key: string) => string,
): Finding[] {
  const findings: Finding[] = [];
  const seen = new Set<string>();

  for (const occurrence of occurrences) {
    if (seen.has(occurrence.key)) {
      findings.push(finding(code, occurrence.path, message(occurrence.key)));
    } else {
      seen.add(occurrence.key);
    }
  }

  return findings;
}

/** Emit a finding for the second and every later occurrence of each identity. */
export const identity: Rule = (_doc, ctx) => {
  const findings: Finding[] = [];

  findings.push(
    ...duplicates(
      ctx.hostOccurrences,
      "HOST_DUPLICATE",
      (name) => `Host name ${JSON.stringify(name)} is declared more than once.`,
    ),
    ...duplicates(
      ctx.serviceOccurrences,
      "SERVICE_DUPLICATE",
      (key) => {
        const [host, name] = key.split("\0");
        return `Service (${JSON.stringify(host)}, ${JSON.stringify(name)}) is declared more than once.`;
      },
    ),
  );

  for (const [collection, occurrences] of Object.entries(ctx.idOccurrences)) {
    findings.push(
      ...duplicates(
        occurrences,
        "ID_DUPLICATE",
        (id) =>
          `Id ${JSON.stringify(id)} is used more than once within ${collection}.`,
      ),
    );
  }

  return findings;
};

/**
 * Provider ids are one space: an `integrations[]` id, a `sources[]` id and a binding's id
 * ({@link estateProviderIds}, the derivation boot registers bindings with) should not repeat.
 * Validation cannot tell which declarations really register a provider (some kinds register
 * under a fixed id, some never register), so a shared id is a warning, not an error: a clash
 * between two that do register still fails boot (PROVIDER_DUPLICATE_ID). Judge only the merged
 * document, since a layer alone lacks ids its bindings inherit. A repeat within `integrations`
 * or `sources` keeps its ID_DUPLICATE; every other repeat is reported once, naming the first use.
 */
export function providerIdSharing(doc: Parameters<Rule>[0]): Finding[] {
  const findings: Finding[] = [];
  const first = new Map<string, { path: string; collection: string }>();
  for (const { id, path, collection } of estateProviderIds(doc)) {
    const earlier = first.get(id);
    if (earlier === undefined) {
      first.set(id, { path, collection });
    } else if (earlier.collection !== collection || collection === "bindings") {
      findings.push(
        finding(
          "PROVIDER_ID_SHARED",
          path,
          `Provider id ${JSON.stringify(id)} at ${path} is also used at ${earlier.path}.`,
        ),
      );
    }
  }
  return findings;
}
