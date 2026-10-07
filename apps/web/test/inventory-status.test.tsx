// @vitest-environment jsdom
import type { Finding } from "@deck/schema";
import type {
  HostState,
  ProviderEnvelope,
  SnapshotProviderResult,
} from "@deck/server";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import {
  HOST_STATE_UI,
  HOST_STATUS_UI,
  HostStateChip,
  INVENTORY_MARKER_UI,
  InventoryMarker,
  NoSnapshotMarker,
  NotDeclaredMarker,
  SERVICE_STATE_UI,
  SERVICE_STATUS_UI,
} from "../src/features/hosts-and-services/components/HostStateChip.js";
import {
  SnapshotStatus,
  visibleSnapshotFindings,
} from "../src/features/hosts-and-services/components/SnapshotStatus.js";
import type { SnapshotClientState } from "../src/features/hosts-and-services/use-inventory-data.js";

afterEach(cleanup);

const COLLECTED_AT = "2030-01-01T00:00:00.000Z";

function hostState(overrides: Partial<HostState>): HostState {
  return {
    state: "fresh",
    collectedAt: COLLECTED_AT,
    ageMs: 180_000,
    pastStaleThreshold: false,
    ...overrides,
  };
}

/** The badge (icon + label) inside a rendered marker or chip. */
function badgeOf(container: HTMLElement): HTMLElement {
  return container.querySelector<HTMLElement>('[data-slot="status-badge"]')!;
}

// ---------------------------------------------------------------------------
// HostStateChip — icon + text for every state, timestamps, and null handling.
// ---------------------------------------------------------------------------

describe("HostStateChip", () => {
  it("renders an aria-hidden icon plus the visible label for every collection state", () => {
    for (const [state, presentation] of Object.entries(HOST_STATE_UI)) {
      const empty = state === "unreachable" || state === "never-collected";
      const { container, unmount } = render(
        <HostStateChip
          state={hostState({
            state: state as HostState["state"],
            collectedAt: empty ? null : COLLECTED_AT,
            ageMs: empty ? null : 180_000,
          })}
        />,
      );
      const badge = badgeOf(container);
      expect(badge).toHaveTextContent(presentation.label);
      expect(badge).toHaveAttribute("data-tone", presentation.tone);
      expect(badge.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
      expect(container.querySelector("[data-host-state]")).toHaveAttribute("data-host-state", state);
      unmount();
    }
  });

  it("shows absolute <time> and relative age together", () => {
    render(<HostStateChip state={hostState({ ageMs: 180_000 })} />);
    const time = screen.getByText(COLLECTED_AT);
    expect(time.tagName).toBe("TIME");
    expect(time).toHaveAttribute("dateTime", COLLECTED_AT);
    expect(screen.getByText(/Collected/)).toHaveTextContent(`Collected ${COLLECTED_AT} (3m ago)`);
  });

  it("renders absolute time without age when age is defensively null", () => {
    render(<HostStateChip state={hostState({ ageMs: null })} />);
    expect(screen.getByText(COLLECTED_AT)).toBeInTheDocument();
    expect(screen.queryByText(/ago\)/)).toBeNull();
  });

  it("explains a null timestamp differently for unreachable and never-collected", () => {
    const { unmount } = render(
      <HostStateChip state={hostState({ state: "unreachable", collectedAt: null, ageMs: null })} />,
    );
    expect(screen.getByText("No collection timestamp")).toBeInTheDocument();
    unmount();

    render(
      <HostStateChip state={hostState({ state: "never-collected", collectedAt: null, ageMs: null })} />,
    );
    expect(screen.getByText("No collection has been recorded")).toBeInTheDocument();
  });

  it("adds the old-partial phrase without introducing a sixth state", () => {
    const { unmount } = render(
      <HostStateChip state={hostState({ state: "partial", pastStaleThreshold: true })} />,
    );
    expect(screen.getByText(HOST_STATE_UI.partial.label)).toBeInTheDocument();
    expect(screen.getByText(/Past stale threshold/)).toBeInTheDocument();
    unmount();

    render(<HostStateChip state={hostState({ state: "partial" })} />);
    expect(screen.queryByText(/Past stale threshold/)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// InventoryMarker — icon + text for every non-domain marker/state/lifecycle.
// ---------------------------------------------------------------------------

describe("InventoryMarker", () => {
  const everyPresentation = [
    ...Object.values(SERVICE_STATE_UI),
    ...Object.values(SERVICE_STATUS_UI),
    ...Object.values(HOST_STATUS_UI),
    ...Object.values(INVENTORY_MARKER_UI),
  ];

  it("renders an aria-hidden icon and a visible label for every presentation", () => {
    for (const presentation of everyPresentation) {
      for (const variant of ["soft", "outline", "dot"] as const) {
        const { container, unmount } = render(
          <InventoryMarker presentation={presentation} variant={variant} />,
        );
        const badge = badgeOf(container);
        expect(badge).toHaveTextContent(presentation.label);
        expect(badge.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
        expect(badge).not.toHaveAttribute("data-icon");
        unmount();
      }
    }
  });

  it("exposes the label slug as a stable data-marker hook", () => {
    const { container } = render(<InventoryMarker presentation={INVENTORY_MARKER_UI["not-observed"]} />);
    expect(badgeOf(container)).toHaveAttribute("data-marker", "not-observed");
  });

  it("renders the Not declared and No snapshot absence markers", () => {
    render(
      <>
        <NotDeclaredMarker />
        <NoSnapshotMarker />
      </>,
    );
    expect(screen.getByText("Not declared")).toBeInTheDocument();
    expect(screen.getByText("No snapshot")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// visibleSnapshotFindings — severity and undeclared-code filtering.
// ---------------------------------------------------------------------------

function finding(
  code: Finding["code"],
  severity: Finding["severity"],
  path: string,
): Finding {
  return { code, severity, path, message: `msg-${path}` };
}

describe("visibleSnapshotFindings", () => {
  it("keeps warning/error in source order and drops info and undeclared codes", () => {
    const findings: Finding[] = [
      finding("HOST_NOT_COLLECTED", "info", "a"),
      finding("SNAPSHOT_HOST_UNDECLARED", "error", "b"),
      finding("PROVIDER_KIND_UNKNOWN", "warning", "c"),
      finding("SNAPSHOT_SERVICE_UNDECLARED", "error", "d"),
      finding("SCHEMA_INVALID", "error", "e"),
    ];
    const visible = visibleSnapshotFindings(findings);
    expect(visible.map((f) => f.path)).toEqual(["c", "e"]);
  });
});

// ---------------------------------------------------------------------------
// SnapshotStatus — exhaustive client states and retained-data separation.
// ---------------------------------------------------------------------------

function freshness(state: ProviderEnvelope["freshness"]["state"]) {
  return { state, observedAt: COLLECTED_AT, ageMs: 1_000, ttlMs: 60_000 };
}

function emptyEnvelope(
  error: { message: string } | null,
): ProviderEnvelope<null> {
  return {
    id: "snapshot",
    kind: "snapshot",
    freshness: freshness(error === null ? "pending" : "unreachable"),
    data: null,
    error,
  };
}

function result(overrides: Partial<SnapshotProviderResult> = {}): SnapshotProviderResult {
  return {
    snapshot: { schemaVersion: 1, generatedAt: COLLECTED_AT, hosts: [], services: [] } as unknown as SnapshotProviderResult["snapshot"],
    findings: [],
    hostStates: {},
    lastReadAt: COLLECTED_AT,
    readError: null,
    ...overrides,
  };
}

function availableEnvelope(
  data: SnapshotProviderResult,
  error: { message: string } | null = null,
): ProviderEnvelope<SnapshotProviderResult> {
  return {
    id: "snapshot",
    kind: "snapshot",
    freshness: freshness("fresh"),
    data,
    error,
  };
}

function renderStatus(state: SnapshotClientState) {
  const view = render(<SnapshotStatus snapshot={state} />);
  const region = view.container.querySelector("section")!;
  const freshnessBadge = (): Element | null => region.querySelector('[data-slot="freshness-badge"]');
  return { ...view, region, freshnessBadge };
}

describe("SnapshotStatus", () => {
  it("renders not-configured as a labelled region with no freshness badge", () => {
    const { region, freshnessBadge } = renderStatus({ status: "not-configured" });
    expect(screen.getByRole("heading", { level: 2, name: "No snapshot configured" })).toBeInTheDocument();
    expect(region).toHaveAttribute("aria-labelledby", "snapshot-status-heading");
    expect(screen.getByText("Set DECK_SNAPSHOT_SOURCE to add observed reality.")).toBeInTheDocument();
    expect(freshnessBadge()).toBeNull();
  });

  it("renders pending with the provider freshness badge", () => {
    const { freshnessBadge } = renderStatus({ status: "pending", envelope: emptyEnvelope(null) });
    expect(screen.getByRole("heading", { level: 2, name: "Snapshot pending" })).toBeInTheDocument();
    expect(screen.getByText("Awaiting the first snapshot poll.")).toBeInTheDocument();
    expect(freshnessBadge()).toHaveAttribute("data-freshness", "pending");
  });

  it("renders failed-empty as an alert with the safe outer error", () => {
    const { freshnessBadge } = renderStatus({
      status: "failed-empty",
      envelope: emptyEnvelope({ message: "Snapshot request timed out." }),
    });
    expect(screen.getByRole("alert")).toHaveTextContent("Snapshot unavailable");
    expect(screen.getByText("Snapshot request timed out.")).toBeInTheDocument();
    expect(screen.getByText("No successful snapshot has been read.")).toBeInTheDocument();
    expect(freshnessBadge()).toHaveAttribute("data-freshness", "unreachable");
  });

  it("renders request-error as an alert with the safe message and no badge", () => {
    const { freshnessBadge } = renderStatus({
      status: "request-error",
      message: "Snapshot request failed; check the deck server connection.",
    });
    expect(screen.getByRole("alert")).toHaveTextContent("Snapshot request failed");
    expect(
      screen.getByText("Snapshot request failed; check the deck server connection."),
    ).toBeInTheDocument();
    expect(freshnessBadge()).toBeNull();
  });

  it("renders available with the last-read time and a provider badge, and no alert", () => {
    const { freshnessBadge } = renderStatus({
      status: "available",
      envelope: availableEnvelope(result()),
    });
    expect(screen.getByRole("heading", { level: 2, name: "Snapshot available" })).toBeInTheDocument();
    expect(screen.getByText(/Last successful snapshot read:/)).toBeInTheDocument();
    expect(screen.getByText(COLLECTED_AT).tagName).toBe("TIME");
    expect(freshnessBadge()).toHaveAttribute("data-freshness", "fresh");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps retained data while alerting on a structured read error", () => {
    const { freshnessBadge } = renderStatus({
      status: "available",
      envelope: availableEnvelope(
        result({ readError: { code: "POLL_TIMEOUT", message: "Snapshot read timed out." } }),
        { message: "outer poll failure" },
      ),
    });
    // Retained status and badge stay visible.
    expect(screen.getByRole("heading", { level: 2, name: "Snapshot available" })).toBeInTheDocument();
    expect(freshnessBadge()).not.toBeNull();
    // The alert prefers the structured message and does not duplicate the outer one.
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(
      "Latest snapshot read failed; showing the last successful snapshot.",
    );
    expect(alert).toHaveTextContent("Snapshot read timed out.");
    expect(screen.queryByText("outer poll failure")).toBeNull();
  });

  it("falls back to the outer error message when structured error is null", () => {
    renderStatus({
      status: "available",
      envelope: availableEnvelope(result({ readError: null }), { message: "outer poll failure" }),
    });
    expect(screen.getByRole("alert")).toHaveTextContent("outer poll failure");
  });

  it("discloses the filtered findings, excluding undeclared codes", async () => {
    const user = userEvent.setup();
    renderStatus({
      status: "available",
      envelope: availableEnvelope(
        result({
          findings: [
            finding("SNAPSHOT_HOST_UNDECLARED", "error", "hosts/x"),
            finding("PROVIDER_KIND_UNKNOWN", "warning", "providers/y"),
          ],
        }),
      ),
    });
    const toggle = screen.getByRole("button", { name: /1 snapshot validation warning\(s\) or error\(s\)/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await user.click(toggle);
    const list = screen.getByRole("list");
    expect(within(list).getAllByRole("listitem")).toHaveLength(1);
    expect(list).toHaveTextContent("PROVIDER_KIND_UNKNOWN");
    expect(list).not.toHaveTextContent("SNAPSHOT_HOST_UNDECLARED");
  });

  it("omits the findings disclosure when no actionable findings exist", () => {
    renderStatus({
      status: "available",
      envelope: availableEnvelope(result({ findings: [finding("HOST_NOT_COLLECTED", "info", "hosts/z")] })),
    });
    expect(screen.queryByRole("button", { name: /snapshot validation/ })).toBeNull();
  });
});
