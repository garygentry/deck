import { describe, expect, it } from "vitest";
import { TONES, isIconName, type StatusMap } from "@/ui";
import {
  HOST_STATE_UI,
  HOST_STATUS_UI,
  INVENTORY_MARKER_UI,
  SERVICE_STATE_UI,
  SERVICE_STATUS_UI,
} from "../src/features/hosts-and-services/components/HostStateChip.js";
import { AA_TEXT_TOKENS } from "./support/tokens.js";

// ---------------------------------------------------------------------------
// Inventory presentation wiring. Every state names a status tone, whose
// `--status-{tone}-fg` text token `tokens-contrast.test.ts` holds to WCAG AA on
// every surface, plus a curated icon and a visible label (never colour alone).
// ---------------------------------------------------------------------------

/** Every closed presentation map iterated as `(group, map)`. */
const PRESENTATION_GROUPS: readonly (readonly [string, StatusMap<string>])[] = [
  ["host state", HOST_STATE_UI],
  ["service state", SERVICE_STATE_UI],
  ["lifecycle", SERVICE_STATUS_UI],
  ["host lifecycle", HOST_STATUS_UI],
  ["marker", INVENTORY_MARKER_UI],
];

describe("inventory presentation contrast", () => {
  for (const [group, map] of PRESENTATION_GROUPS) {
    for (const [key, presentation] of Object.entries(map)) {
      describe(`${group} ${key}`, () => {
        it("has a curated icon and a visible label", () => {
          expect(isIconName(presentation.icon)).toBe(true);
          expect(presentation.label).not.toBe("");
        });

        it("uses a status tone whose text token is AA-guaranteed", () => {
          expect(TONES).toContain(presentation.tone);
          expect(AA_TEXT_TOKENS).toContain(`--status-${presentation.tone}-fg`);
        });
      });
    }
  }

  it("keeps the host lifecycle identical to the service lifecycle", () => {
    expect(HOST_STATUS_UI).toEqual(SERVICE_STATUS_UI);
  });
});
