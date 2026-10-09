import type { StatusPresentation, Tone } from "@/ui/lib/status";

/**
 * How a mark is drawn, on top of its tone. Two states can share a tone (e.g. suppressed and
 * unknown, both neutral), so the one shown as an outline badge gets its own shape (a hatched
 * area, a dashed line) instead of a second shade of the same tone.
 */
export type VizMarkPattern = "solid" | "hatched";

export interface VizStatusMark {
  tone: Tone;
  pattern: VizMarkPattern;
}

/** What a mark is drawn from: a status-map entry, or just a tone (and badge variant). */
export type VizMarkSource = Pick<StatusPresentation, "tone"> & { variant?: "soft" | "outline" | "dot" | undefined };

/**
 * The mark for a status-map entry: its tone, hatched/dashed when the entry is shown as an
 * outline badge, solid otherwise.
 */
export function presentationMark(source: VizMarkSource): VizStatusMark {
  return { tone: source.tone, pattern: source.variant === "outline" ? "hatched" : "solid" };
}

/** Line dash for a pattern (SVG `stroke-dasharray`). */
export const MARK_DASH: Readonly<Record<VizMarkPattern, readonly number[] | null>> = {
  solid: null,
  hatched: [4, 3],
};

/** Tone utility classes, spelled out so Tailwind's source scan finds every one. */
export const TONE_FILL: Readonly<Record<Tone, string>> = {
  ok: "fill-status-ok-fg",
  warn: "fill-status-warn-fg",
  danger: "fill-status-danger-fg",
  info: "fill-status-info-fg",
  pending: "fill-status-pending-fg",
  neutral: "fill-status-neutral-fg",
};

export const TONE_STROKE: Readonly<Record<Tone, string>> = {
  ok: "stroke-status-ok-fg",
  warn: "stroke-status-warn-fg",
  danger: "stroke-status-danger-fg",
  info: "stroke-status-info-fg",
  pending: "stroke-status-pending-fg",
  neutral: "stroke-status-neutral-fg",
};
