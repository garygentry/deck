import { finding, type Finding, type FindingCode } from "../../findings.js";
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
    ...duplicates(
      ctx.idOccurrences.groups,
      "ID_DUPLICATE",
      (id) =>
        `Group or subgroup id ${JSON.stringify(id)} is used more than once across the groups tree.`,
    ),
  );

  for (const [collection, occurrences] of Object.entries(ctx.idOccurrences)) {
    if (collection === "groups") continue;
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
