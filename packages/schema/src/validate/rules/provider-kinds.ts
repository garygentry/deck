import { finding, type Finding } from "../../findings.js";
import { KNOWN_PROVIDER_KINDS } from "../../known-kinds.js";
import type { DeckConfigDocument } from "../../types.js";
import type { Context } from "../context.js";

function escapePointerSegment(segment: string): string {
  return segment.replace(/~/g, "~0").replace(/\//g, "~1");
}

/** Report binding and integration provider kinds outside the per-call registry. */
export function providerKinds(
  doc: DeckConfigDocument,
  _ctx: Context,
  knownKinds?: readonly string[],
): Finding[] {
  const known = new Set<string>([
    ...KNOWN_PROVIDER_KINDS,
    ...(knownKinds ?? []),
  ]);
  const findings: Finding[] = [];

  const inspectBindings = (
    bindings: Record<string, unknown> | undefined,
    path: string,
  ): void => {
    for (const kind of Object.keys(bindings ?? {})) {
      if (!known.has(kind)) {
        findings.push(
          finding(
            "PROVIDER_KIND_UNKNOWN",
            `${path}/${escapePointerSegment(kind)}`,
            `provider kind '${kind}' is not registered`,
            "Use a known provider kind or pass it via knownKinds.",
          ),
        );
      }
    }
  };

  for (const [index, host] of (doc.hosts ?? []).entries()) {
    inspectBindings(host.bindings, `/hosts/${index}/bindings`);
  }
  for (const [index, service] of (doc.services ?? []).entries()) {
    inspectBindings(service.bindings, `/services/${index}/bindings`);
  }
  for (const [index, integration] of (doc.integrations ?? []).entries()) {
    if (!known.has(integration.kind)) {
      findings.push(
        finding(
          "PROVIDER_KIND_UNKNOWN",
          `/integrations/${index}/kind`,
          `provider kind '${integration.kind}' is not registered`,
          "Use a known provider kind or pass it via knownKinds.",
        ),
      );
    }
  }

  return findings;
}
