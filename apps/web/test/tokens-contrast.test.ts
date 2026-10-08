import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { THEME_PRESETS, type ThemePreset } from "@deck/contract";
import { converter, parse } from "culori";
import { describe, expect, it } from "vitest";
import {
  AA_TEXT_TOKENS,
  contrastRatio,
  PRESET_OVERRIDES,
  PRESET_TOKENS,
  STATUS_TONES,
  TEXT_SURFACES,
  THEME_TOKENS,
  tokenColor,
  type Mode,
} from "./support/tokens.js";

// ---------------------------------------------------------------------------
// Design-token contrast, parsed from src/styles/theme.css for every preset
// (`ui.theme.preset`) in both modes.
//
// - Every AA text token (foreground, muted-foreground, primary, each status
//   tone's -fg) clears 4.5:1 on background, card and muted, so any state colour
//   that aliases one of them is readable wherever it lands.
// - Each tone's -fg also clears 4.5:1 on its own -bg (chips and banners).
// - Paired foreground/surface tokens clear 4.5:1.
// - Focus ring and form-control edges (`--input`) clear the 3:1 non-text bar.
//   `--border` is a decorative divider and is deliberately not held to 3:1.
// - The ok tone stays ≥40° of hue from the primary, so "healthy" never reads
//   as a link or an action.
// - `high-contrast` raises every text bar to 7:1 (WCAG AAA), the focus ring
//   and form edges to 4.5:1, and holds `--border` to the 3:1 non-text bar.
//
// Colour is never the only status signal (icon + text); these ratios make the
// redundant colour cue legible, not load-bearing.
// ---------------------------------------------------------------------------

const MODES: readonly Mode[] = ["light", "dark"];

const PAIRS: readonly (readonly [string, string])[] = [
  ["--foreground", "--background"],
  ["--card-foreground", "--card"],
  ["--popover-foreground", "--popover"],
  ["--primary-foreground", "--primary"],
  ["--secondary-foreground", "--secondary"],
  ["--accent-foreground", "--accent"],
  ["--destructive-foreground", "--destructive"],
  ["--sidebar-foreground", "--sidebar"],
  ["--sidebar-primary-foreground", "--sidebar-primary"],
  ["--sidebar-accent-foreground", "--sidebar-accent"],
];

const oklch = converter("oklch");

function hue(preset: ThemePreset, mode: Mode, token: string): number {
  const color = oklch(parse(tokenColor(mode, token, preset)));
  if (color?.h === undefined) throw new Error(`${token} has no hue in ${preset} ${mode}`);
  return color.h;
}

const ratio = (preset: ThemePreset, mode: Mode, fg: string, bg: string): number =>
  contrastRatio(tokenColor(mode, fg, preset), tokenColor(mode, bg, preset));

/** The bars a preset is held to: AA everywhere, AAA text for `high-contrast`. */
const BARS = (preset: ThemePreset) =>
  preset === "high-contrast" ? { text: 7, control: 4.5, border: 3 } : { text: 4.5, control: 3, border: undefined };

describe("design token contrast", () => {
  it("defines every status tone with -fg, -bg and -border in both modes", () => {
    for (const mode of MODES) {
      for (const tone of STATUS_TONES) {
        for (const part of ["fg", "bg", "border"]) {
          expect(THEME_TOKENS[mode], `${mode} --status-${tone}-${part}`).toHaveProperty(
            `--status-${tone}-${part}`,
          );
        }
      }
    }
  });

  it("authors every token of every preset as a literal oklch() colour, so this suite can read it", () => {
    for (const preset of THEME_PRESETS) {
      for (const mode of MODES) {
        for (const [token, value] of Object.entries(PRESET_TOKENS[preset][mode])) {
          if (token === "--radius") continue;
          expect(value, `${preset} ${mode} ${token}`).toMatch(/^oklch\([^)]*\)$/);
        }
      }
    }
  });

  for (const preset of THEME_PRESETS) {
    const bars = BARS(preset);
    for (const mode of MODES) {
      describe(`${preset} ${mode}`, () => {
        for (const token of AA_TEXT_TOKENS) {
          for (const surface of TEXT_SURFACES) {
            it(`${token} meets ${bars.text}:1 on ${surface}`, () => {
              expect(ratio(preset, mode, token, surface)).toBeGreaterThanOrEqual(bars.text);
            });
          }
        }

        for (const tone of STATUS_TONES) {
          it(`--status-${tone}-fg meets ${bars.text}:1 on its own -bg`, () => {
            expect(
              ratio(preset, mode, `--status-${tone}-fg`, `--status-${tone}-bg`),
            ).toBeGreaterThanOrEqual(bars.text);
          });
        }

        for (const [fg, bg] of PAIRS) {
          it(`${fg} meets ${bars.text}:1 on ${bg}`, () => {
            expect(ratio(preset, mode, fg, bg)).toBeGreaterThanOrEqual(bars.text);
          });
        }

        for (const token of ["--ring", "--input"]) {
          for (const surface of TEXT_SURFACES) {
            it(`${token} meets the ${bars.control}:1 non-text bar on ${surface}`, () => {
              expect(ratio(preset, mode, token, surface)).toBeGreaterThanOrEqual(bars.control);
            });
          }
        }

        if (bars.border !== undefined) {
          for (const surface of ["--background", "--card"]) {
            it(`--border meets the ${bars.border}:1 non-text bar on ${surface}`, () => {
              expect(ratio(preset, mode, "--border", surface)).toBeGreaterThanOrEqual(bars.border!);
            });
          }
        }

        it("keeps the ok tone at least 40° of hue from primary", () => {
          const delta = Math.abs(hue(preset, mode, "--status-ok-fg") - hue(preset, mode, "--primary"));
          expect(Math.min(delta, 360 - delta)).toBeGreaterThanOrEqual(40);
        });
      });
    }
  }

  it("fails an unparseable or undefined colour rather than passing it", () => {
    expect(() => contrastRatio("", "#fff")).toThrow();
    expect(() => contrastRatio("not-a-colour", "#fff")).toThrow();
    expect(() => tokenColor("light", "--nonexistent")).toThrow();
  });
});

describe("theme presets", () => {
  const css = readFileSync(fileURLToPath(new URL("../src/styles/theme.css", import.meta.url)), "utf8");

  it("styles exactly the presets the config schema accepts", () => {
    const styled = new Set([...css.matchAll(/data-theme-preset="([^"]+)"/g)].map((match) => match[1]));
    expect([...styled].sort()).toEqual(THEME_PRESETS.filter((preset) => preset !== "teal").sort());
  });

  for (const preset of THEME_PRESETS.filter((name) => name !== "teal")) {
    it(`${preset}: its light and dark blocks set the same tokens, so neither mode leaks into the other`, () => {
      const { light, dark } = PRESET_OVERRIDES[preset];
      expect(Object.keys(light).length).toBeGreaterThan(0);
      expect(Object.keys(dark).sort()).toEqual(Object.keys(light).sort());
    });

    it(`${preset}: re-points only colour tokens the default defines`, () => {
      for (const token of Object.keys(PRESET_OVERRIDES[preset].light)) {
        expect(token).not.toBe("--radius");
        expect(THEME_TOKENS.light, `${preset} ${token}`).toHaveProperty(token);
      }
    });
  }
});
