import { describe, expect, it } from "vitest";

import { isIconName, TONES, type StatusPresentation } from "../src/ui/index.js";
import {
  DRIFT_COVERAGE,
  DRIFT_SEVERITY,
  DRIFT_UNRESOLVED_LOCATION,
  DRIFT_WAIVER,
} from "../src/features/drift-and-coverage/constants.js";
import { AA_TEXT_TOKENS, resolveTokenName } from "./support/tokens.js";

// ---------------------------------------------------------------------------
// Drift presentation contrast.
//
// Every drift severity, waiver, coverage and unresolved-location presentation
// names a status tone. A tone paints its text and icon with
// `--status-{tone}-fg`, a theme.css token that `tokens-contrast.test.ts` holds
// to WCAG AA (4.5:1) on every surface, so a drift state is readable without
// per-feature colour maths.
//
// NON-GOAL: this is a token-wiring contract. It does NOT claim broad WCAG
// conformance, prove rendered layout, or replace the Chromium computed-style
// coverage in `drift.spec.ts`.
// ---------------------------------------------------------------------------

/** Every drift presentation as `(group, key, presentation)`. */
const PRESENTATION_CELLS: readonly (readonly [string, string, StatusPresentation])[] = [
  ...Object.entries(DRIFT_SEVERITY).map(([key, p]) => ["severity", key, p] as const),
  ...Object.entries(DRIFT_WAIVER).map(([key, p]) => ["waiver", key, p] as const),
  ...Object.entries(DRIFT_COVERAGE).map(([key, p]) => ["coverage", key, p] as const),
  ["unresolved", "location", DRIFT_UNRESOLVED_LOCATION] as const,
];

describe("drift presentation contrast", () => {
  it("resolves a non-empty presentation universe (3 severity + 3 waiver + 5 coverage + 1 unresolved)", () => {
    // Universe guard: a shrunk map must not let the per-cell matrix vacuously pass.
    expect(PRESENTATION_CELLS.length).toBe(12);
    expect(Object.keys(DRIFT_SEVERITY)).toHaveLength(3);
    expect(Object.keys(DRIFT_WAIVER)).toHaveLength(3);
    expect(Object.keys(DRIFT_COVERAGE)).toHaveLength(5);
  });

  for (const [group, key, presentation] of PRESENTATION_CELLS) {
    describe(`${group} ${key}`, () => {
      it("has a visible label, a curated icon, and a known tone", () => {
        // Text is the authoritative label; icon and tone are strictly redundant.
        expect(presentation.label).not.toBe("");
        expect(isIconName(presentation.icon)).toBe(true);
        expect(TONES).toContain(presentation.tone);
      });

      it("paints with an AA-guaranteed text token", () => {
        const token = resolveTokenName(`--status-${presentation.tone}-fg`);
        expect(AA_TEXT_TOKENS).toContain(token);
      });
    });
  }

  it("fails an undefined token rather than resolving to a default", () => {
    expect(() => resolveTokenName("--nonexistent")).toThrow();
    expect(() => resolveTokenName("--status-nope-fg")).toThrow();
  });
});
