import { describe, expect, it } from "vitest";
import { validate } from "../src/index.js";

const doc = (llmUsage: unknown) => ({ schemaVersion: 1, estate: { name: "test" }, llmUsage });
const codes = (result: ReturnType<typeof validate>) => result.findings.map((item) => item.code);

describe("llmUsage section", () => {
  it("accepts a full section and an empty one", () => {
    expect(validate(doc({})).classification).toBe(0);
    expect(validate(doc({
      claude: {
        credentialsFile: "/secrets/claude/.credentials.json",
        transcriptsDir: "/data/claude/projects",
        statusLine: { credentialEnv: "DECK_LLM_USAGE_INGEST_TOKEN" },
        activeInterval: "PT2M",
        idleInterval: "PT5M",
      },
      codex: { codexHome: "/data/codex", command: "/usr/local/bin/codex", rolloutDir: "/data/codex/sessions" },
      thresholds: { warn: 75, danger: 90 },
      idlePause: "PT5M",
    }))).toEqual({ classification: 0, findings: [], summary: { error: 0, warning: 0, info: 0 } });
  });

  it("catches the values deck would refuse at boot", () => {
    expect(codes(validate(doc({ idlePause: "5 minutes" })))).toContain("SCHEMA_INVALID");
    expect(codes(validate(doc({ claude: { activeInterval: "-PT5M" } })))).toContain("SCHEMA_INVALID");
    expect(codes(validate(doc({ claude: { idleInterval: "PT0S" } })))).toEqual(["LLM_USAGE_INVALID"]);
    expect(codes(validate(doc({ thresholds: { warn: 95 } })))).toEqual(["LLM_USAGE_INVALID"]);
    expect(codes(validate(doc({ thresholds: { warn: 80, danger: 70 } })))).toEqual(["LLM_USAGE_INVALID"]);
    // A lone danger below the default warn is fine: deck pulls warn down with it.
    expect(validate(doc({ thresholds: { danger: 50 } })).classification).toBe(0);
    expect(validate(doc({ claude: { activeInterval: "PT1H30M", idleInterval: "P1D" }, idlePause: "PT0.5H" })).classification).toBe(0);
  });

  it("rejects unknown keys, a missing codexHome, a lowercase env name, and out-of-range thresholds", () => {
    expect(validate(doc({ gemini: {} })).classification).toBe(1);
    expect(validate(doc({ codex: {} })).classification).toBe(1);
    expect(validate(doc({ claude: { statusLine: { credentialEnv: "not-an-env" } } })).classification).toBe(1);
    expect(validate(doc({ claude: { statusLine: {} } })).classification).toBe(1);
    expect(validate(doc({ thresholds: { warn: 120 } })).classification).toBe(1);
  });

  it("is overlay-owned", () => {
    const base = { schemaVersion: 1, estate: { name: "test" } };
    expect(validate({ schemaVersion: 1, llmUsage: { codex: { codexHome: "/c" } } }, { layer: "overlay", base }).classification).toBe(0);
    expect(codes(validate({ ...base, llmUsage: {} }, { layer: "base" }))).toContain("LAYER_OVERLAY_KEY_IN_BASE");
  });
});
