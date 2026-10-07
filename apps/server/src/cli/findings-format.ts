import type { Finding } from "@deck/schema";
import type { ConfigDirError } from "../config/load.js";

export function formatFinding(finding: Finding): string {
  return `${finding.severity}  ${finding.path || "/"}  ${finding.code}  ${finding.message}`;
}

export function formatFindings(findings: readonly Finding[]): string {
  return findings.map(formatFinding).join("\n");
}

export function formatToolError(
  toolError: ConfigDirError | { code: string; message: string; path?: string },
): string {
  const path = "path" in toolError && toolError.path ? `  ${toolError.path}` : "";
  return `${toolError.code}${path}  ${toolError.message}`;
}
