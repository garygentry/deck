// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { createElement as h } from "react";
import { afterEach, describe, expect, it } from "vitest";
import type { ActionOutcome } from "../../server/types.js";
import { TONES, isIconName } from "@/ui";

import { RunOutput } from "../../web/components/RunOutput.js";
import { OUTCOME_UI } from "../../web/status.js";
import type { RunState } from "../../web/run-store.js";

// ---------------------------------------------------------------------------
// Governed-actions status convention: icon + text, NEVER colour-only. Every
// terminal outcome carries a tone (which picks theme-token colours whose
// contrast the shared token suites verify), a curated decorative icon, and an
// authoritative text label — colour is never the signal on its own.
// ---------------------------------------------------------------------------

afterEach(cleanup);

/** The six ActionOutcome values. Kept as a literal universe guard. */
const EXPECTED_OUTCOMES: readonly ActionOutcome[] = [
  "succeeded",
  "failed",
  "error",
  "rejected",
  "timed-out",
  "cancelled",
];

/** Build a terminal RunState for one outcome. */
function terminalRun(outcome: ActionOutcome): RunState {
  return {
    status: "terminal",
    actionId: "act-x",
    runId: outcome === "rejected" ? null : "run-1",
    outcome,
    exit: outcome === "succeeded" ? 0 : null,
    durationMs: 5,
    stdout: "",
    stderr: "",
    ...(outcome === "rejected"
      ? { refusal: { code: "ACTION_UNKNOWN", message: "No such action." } }
      : {}),
  } as RunState;
}

describe("actions status convention (icon + text, never color-only)", () => {
  it("OUTCOME_UI covers exactly the six outcomes (universe guard)", () => {
    expect(Object.keys(OUTCOME_UI).sort()).toEqual([...EXPECTED_OUTCOMES].sort());
  });

  for (const outcome of EXPECTED_OUTCOMES) {
    describe(`outcome ${outcome}`, () => {
      const ui = OUTCOME_UI[outcome];

      it("has a text label, a curated icon, a tone, and a live-region role", () => {
        expect(ui.label).not.toBe("");
        expect(isIconName(ui.icon)).toBe(true);
        expect(TONES).toContain(ui.tone);
        expect(ui.role === "status" || ui.role === "alert").toBe(true);
      });

      it("carries no raw colour — the tone maps to theme tokens", () => {
        expect(ui).not.toHaveProperty("color");
        expect(ui).not.toHaveProperty("colour");
        expect(ui).not.toHaveProperty("token");
      });

      it("renders the icon aria-hidden AND paired with the text label", () => {
        render(h(RunOutput, { run: terminalRun(outcome), onCancel: () => {}, onDismiss: () => {} }));
        const bannerEl = screen.getByRole(ui.role!);
        expect(bannerEl).toHaveTextContent(ui.label);
        expect(bannerEl.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
      });
    });
  }

  it("failures interrupt (alert); success and cancel are polite (status)", () => {
    expect(OUTCOME_UI.succeeded.role).toBe("status");
    expect(OUTCOME_UI.cancelled.role).toBe("status");
    for (const o of ["failed", "error", "rejected", "timed-out"] as const) {
      expect(OUTCOME_UI[o].role).toBe("alert");
    }
  });

  it("distinct labels per outcome (no two outcomes are indistinguishable by text)", () => {
    const labels = EXPECTED_OUTCOMES.map((o) => OUTCOME_UI[o].label);
    expect(new Set(labels).size).toBe(labels.length);
  });
});
