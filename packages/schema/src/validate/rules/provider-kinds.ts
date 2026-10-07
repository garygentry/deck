import type { ComposedConfig } from "../../compose/compose.js";
import { finding, type Finding } from "../../findings.js";
import type { DeckConfigDocument } from "../../types.js";

function escapePointerSegment(segment: string): string {
  return segment.replace(/~/g, "~0").replace(/\//g, "~1");
}

/**
 * Report binding and integration provider kinds that no composed contribution declares
 * (PROVIDER_KIND_UNKNOWN, a warning), kinds only a module that is not running declares
 * (PROVIDER_KIND_DISABLED: info unless `strict`, so an off module never fails boot), and
 * bindings of a declared kind that does not accept them (PROVIDER_BINDING_UNSUPPORTED, info:
 * the binding is ignored). Provider `kind` is an open string in the schema, so none of these
 * is a shape error.
 */
export function providerKinds(
  doc: DeckConfigDocument,
  composed: Pick<ComposedConfig, "knownKinds" | "bindableKinds" | "disabledKinds">,
  strict: boolean,
): Finding[] {
  const { knownKinds: known, bindableKinds: bindable, disabledKinds } = composed;
  const findings: Finding[] = [];
  /** A reference to `kind` that is not known: off module's kind, or truly unknown. */
  const unknownKind = (kind: string, path: string): Finding => {
    const owner = disabledKinds.get(kind);
    if (owner === undefined) {
      return finding(
        "PROVIDER_KIND_UNKNOWN",
        path,
        `provider kind '${kind}' is not registered`,
        "Use a known provider kind or install the module that provides it.",
      );
    }
    const disabled = finding(
      "PROVIDER_KIND_DISABLED",
      path,
      `provider kind '${kind}' is provided by module "${owner}", which is not enabled; references to it are ignored`,
      `Enable or fix module "${owner}", or remove the reference.`,
    );
    return strict ? disabled : { ...disabled, severity: "info" };
  };

  const inspectBindings = (
    bindings: Record<string, unknown> | undefined,
    path: string,
  ): void => {
    for (const kind of Object.keys(bindings ?? {})) {
      if (!known.has(kind)) {
        findings.push(unknownKind(kind, `${path}/${escapePointerSegment(kind)}`));
      } else if (!bindable.has(kind)) {
        findings.push(
          finding(
            "PROVIDER_BINDING_UNSUPPORTED",
            `${path}/${escapePointerSegment(kind)}`,
            `provider kind '${kind}' does not accept host or service bindings`,
            "Remove the binding, or declare it as an integration if the kind supports one.",
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
    if (!known.has(integration.kind)) findings.push(unknownKind(integration.kind, `/integrations/${index}/kind`));
  }

  return findings;
}
