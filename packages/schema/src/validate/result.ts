import { classify, type Finding } from "../findings.js";
import type {
  FindingSummary,
  ToolErrorCode,
  ValidationResult,
} from "../types.js";

export function sortFindings(findings: readonly Finding[]): Finding[] {
  return [...findings].sort(
    (a, b) =>
      (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) ||
      (a.code < b.code ? -1 : a.code > b.code ? 1 : 0) ||
      (a.message < b.message ? -1 : a.message > b.message ? 1 : 0),
  );
}

export function summarise(findings: readonly Finding[]): FindingSummary {
  const summary: FindingSummary = { error: 0, warning: 0, info: 0 };
  for (const item of findings) summary[item.severity]++;
  return summary;
}

export function build(findings: readonly Finding[]): ValidationResult {
  const sorted = sortFindings(findings);
  return {
    classification: classify(sorted),
    findings: sorted,
    summary: summarise(sorted),
  };
}

export function toolError(code: ToolErrorCode, message: string): ValidationResult {
  return { classification: 2, findings: [], toolError: { code, message } };
}
