import type { ConfigRule, ConfigRuleFinding, FindingCodeDecl } from "@deck/module-sdk";

import type { LlmUsage } from "./config.generated.js";

/** The finding code the llm-usage section rule emits. */
export const LLM_USAGE_INVALID: FindingCodeDecl = {
  code: "LLM_USAGE_INVALID",
  severity: "error",
  summary: "The llm-usage module section has values deck cannot run with.",
  fix: "Use positive ISO-8601 durations and keep thresholds.warn at or below thresholds.danger.",
};

const DURATIONS = [
  ["/claude/activeInterval", (section: LlmUsage) => section.claude?.activeInterval],
  ["/claude/idleInterval", (section: LlmUsage) => section.claude?.idleInterval],
  ["/idlePause", (section: LlmUsage) => section.idlePause],
] as const;

/**
 * Values the llm-usage schema cannot rule out but deck refuses at boot: a zero duration
 * (the schema pattern already rejects malformed ones), and an explicit `warn` above
 * `danger`. Thresholds may be split across layers, so only the merged document is judged.
 */
export const llmUsageValues: ConfigRule<LlmUsage> = (section, { layer }) => {
  if (layer !== "merged") return [];
  const findings: ConfigRuleFinding[] = [];
  for (const [path, read] of DURATIONS) {
    const value = read(section);
    if (typeof value === "string" && !/[1-9]/.test(value)) {
      findings.push({ code: LLM_USAGE_INVALID.code, path, message: `duration "${value}" must be longer than zero` });
    }
  }
  // Deck derives a missing `warn` from `danger`, so only an explicit `warn` can conflict.
  const thresholds = section.thresholds;
  if (thresholds?.warn !== undefined) {
    const danger = thresholds.danger ?? 90;
    if (thresholds.warn > danger) {
      findings.push({ code: LLM_USAGE_INVALID.code, path: "/thresholds", message: `warn (${thresholds.warn}) exceeds danger (${danger})` });
    }
  }
  return findings;
};
