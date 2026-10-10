import { join } from "node:path";

import { parse, pattern, toSeconds } from "iso8601-duration";


import { OAUTH_FLOOR_MS } from "./cadence.js";
import type { LlmUsage } from "./config.generated.js";
import type { UsageThresholds } from "./types.js";

export const DEFAULT_THRESHOLDS: UsageThresholds = { warn: 75, danger: 90 };
export const DEFAULT_ACTIVE_MS = 120_000;
export const DEFAULT_IDLE_MS = 300_000;
export const DEFAULT_IDLE_PAUSE_MS = 300_000;
/** OAuth intervals are clamped to at most a day. */
export const MAX_INTERVAL_MS = 86_400_000;

export interface ResolvedLlmUsageConfig {
  thresholds: UsageThresholds;
  idlePauseMs: number;
  claude: {
    credentialsFile: string | null;
    transcriptsDir: string | null;
    /** Env var holding the ingest bearer token; null disables the ingest route. */
    statusLineCredentialEnv: string | null;
    activeMs: number;
    idleMs: number;
  } | null;
  codex: {
    codexHome: string;
    command: string;
    rolloutDir: string;
  } | null;
}

export class LlmUsageConfigError extends Error {
  constructor(readonly path: string, message: string) {
    super(`/modules/llm-usage${path}: ${message}`);
    this.name = "LlmUsageConfigError";
  }
}

// Anchor the library's own grammar so junk or a sign ("-PT5M") is rejected, as the
// snapshot freshness parser does.
const WHOLE_DURATION = new RegExp(`^${pattern.source}$`);

function durationMs(value: string | undefined, fallback: number, path: string): number {
  if (value === undefined) return fallback;
  let seconds: number;
  try {
    if (!WHOLE_DURATION.test(value.replace(/,/g, "."))) throw new RangeError("invalid");
    seconds = toSeconds(parse(value));
  } catch {
    throw new LlmUsageConfigError(path, `"${value}" is not an ISO-8601 duration`);
  }
  const ms = seconds * 1000;
  if (!Number.isFinite(ms) || ms <= 0) throw new LlmUsageConfigError(path, "duration must be positive");
  return ms;
}

const clampInterval = (ms: number) => Math.min(MAX_INTERVAL_MS, Math.max(OAUTH_FLOOR_MS, ms));

/**
 * Resolve the optional `modules.llm-usage` section with defaults. Returns null when absent
 * (feature off). OAuth intervals are clamped into [120s, 1 day], never honoured outside it.
 */
export function resolveLlmUsageSection(section: LlmUsage | undefined): ResolvedLlmUsageConfig | null {
  if (!section) return null;

  // Only an explicit pair can conflict: a lone `danger` below the default `warn` pulls `warn` down with it.
  const danger = section.thresholds?.danger ?? DEFAULT_THRESHOLDS.danger;
  const thresholds = { warn: section.thresholds?.warn ?? Math.min(DEFAULT_THRESHOLDS.warn, danger), danger };
  if (thresholds.warn > thresholds.danger) {
    throw new LlmUsageConfigError("/thresholds", `warn (${thresholds.warn}) exceeds danger (${thresholds.danger})`);
  }

  const claude = section.claude
    ? {
      credentialsFile: section.claude.credentialsFile ?? null,
      transcriptsDir: section.claude.transcriptsDir ?? null,
      statusLineCredentialEnv: section.claude.statusLine?.credentialEnv ?? null,
      activeMs: clampInterval(durationMs(section.claude.activeInterval, DEFAULT_ACTIVE_MS, "/claude/activeInterval")),
      idleMs: clampInterval(durationMs(section.claude.idleInterval, DEFAULT_IDLE_MS, "/claude/idleInterval")),
    }
    : null;

  const codex = section.codex
    ? {
      codexHome: section.codex.codexHome,
      command: section.codex.command ?? "codex",
      rolloutDir: section.codex.rolloutDir ?? join(section.codex.codexHome, "sessions"),
    }
    : null;

  return {
    thresholds,
    idlePauseMs: durationMs(section.idlePause, DEFAULT_IDLE_PAUSE_MS, "/idlePause"),
    claude,
    codex,
  };
}
