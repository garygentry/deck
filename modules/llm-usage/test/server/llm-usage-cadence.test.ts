import { describe, expect, it } from "vitest";

import { type CadenceState, ERROR_BACKOFF_MAX_MS, nextDelay, OAUTH_FLOOR_MS, pollMode } from "../../server/cadence.js";
import { LlmUsageConfigError, resolveLlmUsageSection } from "../../server/config.js";

const now = 1_000_000_000_000;
const state = (overrides: Partial<CadenceState> = {}): CadenceState => ({
  now,
  activeMs: 120_000,
  idleMs: 300_000,
  idlePauseMs: 300_000,
  lastPushAt: null,
  lastChangeAt: null,
  lastViewerAt: now,
  consecutiveErrors: 0,
  retryAfterMs: 0,
  ...overrides,
});

describe("llm-usage cadence", () => {
  it("pauses with no recent viewer", () => {
    expect(pollMode(state({ lastViewerAt: null }))).toBe("paused");
    expect(nextDelay(state({ lastViewerAt: now - 300_000 }))).toBeNull();
    expect(pollMode(state({ lastViewerAt: now - 299_999 }))).toBe("idle");
  });

  it("polls at the active cadence after a push or a change, idle otherwise", () => {
    expect(nextDelay(state())).toBe(300_000);
    expect(nextDelay(state({ lastPushAt: now - 1000 }))).toBe(120_000);
    expect(nextDelay(state({ lastChangeAt: now - 119_999 }))).toBe(120_000);
    expect(pollMode(state({ lastChangeAt: now - 120_000 }))).toBe("idle");
  });

  it("never goes below the OAuth floor", () => {
    expect(nextDelay(state({ activeMs: 10_000, lastPushAt: now }))).toBe(OAUTH_FLOOR_MS);
  });

  it("backs off from the floor, doubling to the cap, honouring a longer Retry-After", () => {
    expect([1, 2, 3, 4].map((errors) => nextDelay(state({ consecutiveErrors: errors })))).toEqual(
      [120_000, 240_000, ERROR_BACKOFF_MAX_MS, ERROR_BACKOFF_MAX_MS],
    );
    expect(nextDelay(state({ consecutiveErrors: 1, retryAfterMs: 900_000 }))).toBe(900_000);
    expect(pollMode(state({ consecutiveErrors: 1 }))).toBe("backoff");
  });
});

describe("llmUsage config resolution", () => {
  const doc = (llmUsage: unknown) => llmUsage as Parameters<typeof resolveLlmUsageSection>[0];

  it("is off when absent and applies defaults when present", () => {
    expect(resolveLlmUsageSection(undefined)).toBeNull();
    expect(resolveLlmUsageSection(doc({ claude: {}, codex: { codexHome: "/c" } }))).toEqual({
      thresholds: { warn: 75, danger: 90 },
      idlePauseMs: 300_000,
      claude: { credentialsFile: null, transcriptsDir: null, statusLineCredentialEnv: null, activeMs: 120_000, idleMs: 300_000 },
      codex: { codexHome: "/c", command: "codex", rolloutDir: "/c/sessions" },
    });
  });

  it("clamps OAuth intervals to the floor and parses durations", () => {
    const resolved = resolveLlmUsageSection(doc({ claude: { activeInterval: "PT30S", idleInterval: "PT10M" }, idlePause: "PT1M" }));
    expect(resolved?.claude).toMatchObject({ activeMs: 120_000, idleMs: 600_000 });
    expect(resolved?.idlePauseMs).toBe(60_000);
  });

  it("rejects malformed durations and inverted thresholds", () => {
    expect(() => resolveLlmUsageSection(doc({ idlePause: "5m" }))).toThrow(LlmUsageConfigError);
    expect(() => resolveLlmUsageSection(doc({ idlePause: "-PT5M" }))).toThrow(LlmUsageConfigError);
    expect(() => resolveLlmUsageSection(doc({ thresholds: { warn: 95 } }))).toThrow(/warn \(95\) exceeds danger \(90\)/);
    // Errors name the v2 location of the value, never the v1 `llmUsage` key.
    expect(() => resolveLlmUsageSection(doc({ thresholds: { warn: 95 } }))).toThrow(/^\/modules\/llm-usage\/thresholds: /);
    expect(resolveLlmUsageSection(doc({ thresholds: { danger: 50 } }))?.thresholds).toEqual({ warn: 50, danger: 50 });
    expect(resolveLlmUsageSection(doc({ claude: { idleInterval: "P1Y" } }))?.claude?.idleMs).toBe(86_400_000);
  });
});
