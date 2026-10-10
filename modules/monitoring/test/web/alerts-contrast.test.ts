import { describe, expect, it } from "vitest";

import { TONES, type StatusMap } from "@/ui";
import {
  ALERT_BADGE_PRESENTATION,
  HEADER_STATUS_PRESENTATION,
  STATUS_PRESENTATION,
} from "../../web/status.js";
import { AA_TEXT_TOKENS, THEME_TOKENS } from "@web-test/support/tokens.js";

// ---------------------------------------------------------------------------
// Alerts-and-health status-tone wiring.
//
// Every state in the feature's status maps names a tone whose `--status-{tone}-fg`
// token is a theme.css text token held to WCAG AA on every surface (light and
// dark) by `tokens-contrast.test.ts`, so the feature introduces no colour that
// fails the shared accessibility bar.
// ---------------------------------------------------------------------------

const MAPS: ReadonlyArray<[string, StatusMap<string>]> = [
  ["STATUS_PRESENTATION", STATUS_PRESENTATION],
  ["HEADER_STATUS_PRESENTATION", HEADER_STATUS_PRESENTATION],
  ["ALERT_BADGE_PRESENTATION", ALERT_BADGE_PRESENTATION],
];

describe("alerts status contrast", () => {
  for (const [name, map] of MAPS) {
    for (const [state, presentation] of Object.entries(map)) {
      it(`${name}.${state} uses a tone whose foreground is an AA-guaranteed text token`, () => {
        expect(TONES).toContain(presentation.tone);
        const token = `--status-${presentation.tone}-fg`;
        expect(AA_TEXT_TOKENS).toContain(token);
        expect(THEME_TOKENS.light[token]).toBeDefined();
        expect(THEME_TOKENS.dark[token]).toBeDefined();
      });
    }
  }

  it("keeps an unavailable source neutral, distinct from a critical breach", () => {
    expect(STATUS_PRESENTATION.error.tone).toBe("neutral");
    expect(STATUS_PRESENTATION.critical.tone).toBe("danger");
  });
});
