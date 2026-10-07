// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import type { FreshnessStamp } from "@deck/server";

import { EmptyState, ErrorState, FRESHNESS_STATUS, FreshnessBadge, TONES } from "@/ui";
import { FILE_NOTICE } from "../src/features/sources-docs-and-configs/status.js";
import { BinaryPlaceholder } from "../src/features/sources-docs-and-configs/components/BinaryPlaceholder.js";
import { TruncatedNotice } from "../src/features/sources-docs-and-configs/components/TruncatedNotice.js";

// ---------------------------------------------------------------------------
// Sources status convention (SC-14 / REQ-A11Y-01): every status/placeholder surface this feature
// renders conveys its state by an aria-hidden ICON *plus* an authoritative TEXT label — colour is
// never the sole signal.
//
// PROTECTION SET (enumerated, closed): the freshness badges this feature renders for the three
// staleness-bearing states (fresh / stale / unreachable) and the four browsing placeholders
// (empty / error / binary / truncated). NON-GOALS: this guard does NOT police any other feature's
// status surfaces and does NOT assert WCAG contrast ratios (the token contrast suite owns those).
// ---------------------------------------------------------------------------

afterEach(cleanup);

function stamp(state: FreshnessStamp["state"]): FreshnessStamp {
  return { state, observedAt: "2026-09-17T00:00:00.000Z", ageMs: 5_000, ttlMs: 30_000 };
}

interface StatusSurface {
  readonly name: string;
  readonly text: string | RegExp;
  readonly element: ReactElement;
}

const STATUS_SURFACES: readonly StatusSurface[] = [
  { name: "freshness: fresh", text: "Fresh", element: <FreshnessBadge freshness={stamp("fresh")} /> },
  { name: "freshness: stale", text: "Stale", element: <FreshnessBadge freshness={stamp("stale")} /> },
  {
    name: "freshness: unreachable",
    text: "Unreachable",
    element: <FreshnessBadge freshness={stamp("unreachable")} />,
  },
  { name: "placeholder: empty", text: "Nothing to show", element: <EmptyState title="Nothing to show" /> },
  {
    name: "placeholder: error",
    text: "This source could not be loaded",
    element: <ErrorState title="This source could not be loaded" message="safe detail" />,
  },
  { name: "placeholder: binary", text: /binary file/, element: <BinaryPlaceholder path="logo.png" /> },
  {
    name: "placeholder: truncated",
    text: /too large/,
    element: <TruncatedNotice path="huge.log" size={2 * 1024 * 1024} />,
  },
];

describe("sources status convention (icon + text, never colour-only)", () => {
  it("protects exactly the enumerated status surfaces (universe guard)", () => {
    expect(STATUS_SURFACES.map((s) => s.name)).toEqual([
      "freshness: fresh",
      "freshness: stale",
      "freshness: unreachable",
      "placeholder: empty",
      "placeholder: error",
      "placeholder: binary",
      "placeholder: truncated",
    ]);
  });

  it("gives each staleness state and each file notice a tone, an icon AND a label", () => {
    for (const presentation of [
      FRESHNESS_STATUS.fresh,
      FRESHNESS_STATUS.stale,
      FRESHNESS_STATUS.unreachable,
      FILE_NOTICE.binary,
      FILE_NOTICE.truncated,
    ]) {
      expect(TONES).toContain(presentation.tone);
      expect(presentation.icon).not.toBe("");
      expect(presentation.label).not.toBe("");
    }
  });

  it("announces the file notices politely (expected conditions, not errors)", () => {
    expect(FILE_NOTICE.binary.role).toBe("status");
    expect(FILE_NOTICE.truncated.role).toBe("status");
  });

  for (const surface of STATUS_SURFACES) {
    it(`${surface.name}: a decorative (aria-hidden) icon paired with authoritative text`, () => {
      const { container } = render(surface.element);
      expect(container.querySelector("svg[aria-hidden='true']")).not.toBeNull();
      expect(screen.getAllByText(surface.text).length).toBeGreaterThan(0);
    });
  }
});
