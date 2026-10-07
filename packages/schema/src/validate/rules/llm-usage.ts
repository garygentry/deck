import { finding, type Finding } from "../../findings.js";
import type { DeckConfigDocument } from "../../types.js";

const DURATION_KEYS = [
  ["/llmUsage/claude/activeInterval", (doc: DeckConfigDocument) => doc.llmUsage?.claude?.activeInterval],
  ["/llmUsage/claude/idleInterval", (doc: DeckConfigDocument) => doc.llmUsage?.claude?.idleInterval],
  ["/llmUsage/idlePause", (doc: DeckConfigDocument) => doc.llmUsage?.idlePause],
] as const;

/**
 * `llmUsage` values the schema shape cannot rule out but deck refuses at boot: a zero
 * duration (the schema pattern already rejects malformed ones), and an explicit `warn`
 * above `danger`.
 */
export function llmUsage(doc: DeckConfigDocument): Finding[] {
  const findings: Finding[] = [];
  for (const [path, read] of DURATION_KEYS) {
    const value = read(doc);
    if (typeof value === "string" && !/[1-9]/.test(value)) {
      findings.push(finding("LLM_USAGE_INVALID", path, `duration "${value}" must be longer than zero`));
    }
  }
  // Deck derives a missing `warn` from `danger`, so only an explicit `warn` can conflict.
  const thresholds = doc.llmUsage?.thresholds;
  if (thresholds?.warn !== undefined) {
    const danger = thresholds.danger ?? 90;
    if (thresholds.warn > danger) {
      findings.push(finding("LLM_USAGE_INVALID", "/llmUsage/thresholds", `warn (${thresholds.warn}) exceeds danger (${danger})`));
    }
  }
  return findings;
}
