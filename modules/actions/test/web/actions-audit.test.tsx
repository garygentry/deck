// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuditDetail, AuditListItem } from "../../server/types.js";

import { AuditHistory } from "../../web/components/AuditHistory.js";

// The list load + detail load are effect-driven; loaders are injected so no HTTP
// is involved. Async states are awaited with Testing Library's `find*` queries.

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

const newer: AuditListItem = {
  runId: "run-new",
  timestamp: "2030-01-02T00:00:00.000Z",
  actionId: "restart-db",
  runner: "restart-playbook",
  target: { host: "db01", service: "postgres" },
  outcome: "succeeded",
  exitStatus: 0,
  durationMs: 1200,
  outputBytes: 42,
};

const older: AuditListItem = {
  runId: "run-old",
  timestamp: "2030-01-01T00:00:00.000Z",
  actionId: "clear-cache",
  runner: "cache-runner",
  outcome: "failed",
  exitStatus: 7,
  durationMs: 800,
  outputBytes: 10,
};

const detail: AuditDetail = {
  entry: {
    runId: "run-new",
    timestamp: "2030-01-02T00:00:00.000Z",
    actionId: "restart-db",
    runner: "restart-playbook",
    params: { host: "db01", count: 3, force: true },
    target: { host: "db01", service: "postgres" },
    source: "10.0.0.5",
    outcome: "succeeded",
    exitStatus: 0,
    durationMs: 1200,
    outputBytes: 42,
  },
  output: "restarting db01…\ndone.\n",
};

function region(): HTMLElement {
  return screen.getByRole("region", { name: "Audit history" });
}

// ---------------------------------------------------------------------------
// List states.
// ---------------------------------------------------------------------------

describe("AuditHistory list", () => {
  it("shows a loading status first, then a role=status empty state (not an error)", async () => {
    render(<AuditHistory loadList={() => Promise.resolve([])} />);
    expect(screen.getByRole("status", { name: "Loading history…" })).toBeInTheDocument();
    expect(await screen.findByText("No invocations recorded yet.")).toBeInTheDocument();
    expect(within(region()).getByRole("status")).toHaveTextContent("No invocations recorded yet.");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("renders the disabled notice and never loads the list when enabled=false", () => {
    const loadList = vi.fn(() => Promise.resolve([newer]));
    render(<AuditHistory loadList={loadList} enabled={false} />);
    expect(loadList).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Audit history is unavailable while the actions capability is disabled.",
    );
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("renders a newest-first list with actionId, runner, target, outcome, exit, duration", async () => {
    render(<AuditHistory loadList={() => Promise.resolve([newer, older])} />);
    const rows = await within(region()).findAllByRole("listitem");
    expect(rows).toHaveLength(2);
    const [first, second] = rows;
    expect(within(first!).getByRole("button", { name: "restart-db" })).toBeInTheDocument();
    expect(first).toHaveTextContent("Runner: restart-playbook");
    expect(first).toHaveTextContent("Target: db01 · postgres");
    expect(first).toHaveTextContent("Succeeded");
    expect(first).toHaveTextContent("Exit code 0");
    expect(first).toHaveTextContent("1200 ms");
    expect(within(second!).getByRole("button", { name: "clear-cache" })).toBeInTheDocument();
    expect(second).toHaveTextContent("Failed");
    expect(second).toHaveTextContent("Exit code 7");
    // Row badges are static text: no live region per row.
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("renders a role=alert safe message when the list load fails", async () => {
    render(<AuditHistory loadList={() => Promise.reject(new Error("boom"))} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Failed to load audit history.");
    // The raw error message never leaks.
    expect(document.body).not.toHaveTextContent("boom");
  });
});

// ---------------------------------------------------------------------------
// Detail view.
// ---------------------------------------------------------------------------

describe("AuditHistory detail", () => {
  it("opens an inline per-entry detail with unredacted params and captured output", async () => {
    render(
      <AuditHistory
        loadList={() => Promise.resolve([newer])}
        loadDetail={() => Promise.resolve(detail)}
      />,
    );
    const row = await screen.findByRole("button", { name: "restart-db" });
    fireEvent.click(row);
    expect(await screen.findByRole("heading", { level: 3, name: "restart-db" })).toBeInTheDocument();
    expect(row).toHaveAttribute("aria-current", "true");

    const item = screen.getAllByRole("listitem")[0]!;
    // Source and run id in the entry meta.
    expect(within(item).getByText("10.0.0.5")).toBeInTheDocument();
    expect(within(item).getByText("run-new")).toBeInTheDocument();
    // Unredacted params (name → value).
    const params = within(item).getByLabelText("Parameters");
    expect(within(params).getAllByRole("term").map((t) => t.textContent)).toEqual(["host", "count", "force"]);
    expect(within(params).getAllByRole("definition").map((d) => d.textContent)).toEqual(["db01", "3", "true"]);
    // The captured output.
    const output = within(item).getByRole("figure", { name: "Captured output" });
    expect(output).toHaveTextContent("restarting db01…");
    expect(output).toHaveTextContent("done.");
  });

  it("closes the detail on Close and on Escape, returning focus to the row", async () => {
    render(
      <AuditHistory
        loadList={() => Promise.resolve([newer])}
        loadDetail={() => Promise.resolve(detail)}
      />,
    );
    const row = await screen.findByRole("button", { name: "restart-db" });
    fireEvent.click(row);
    fireEvent.click(await screen.findByRole("button", { name: "Close" }));
    expect(screen.queryByRole("heading", { level: 3 })).toBeNull();
    expect(row).toHaveFocus();

    fireEvent.click(row);
    const heading = await screen.findByRole("heading", { level: 3, name: "restart-db" });
    fireEvent.keyDown(heading, { key: "Escape" });
    expect(screen.queryByRole("heading", { level: 3 })).toBeNull();
  });

  it("closes the detail on Enter on its Close button", async () => {
    const user = userEvent.setup();
    render(
      <AuditHistory
        loadList={() => Promise.resolve([newer])}
        loadDetail={() => Promise.resolve(detail)}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "restart-db" }));
    (await screen.findByRole("button", { name: "Close" })).focus();
    await user.keyboard("{Enter}");
    expect(screen.queryByRole("heading", { level: 3 })).toBeNull();
  });

  it("ignores a slow detail response for a row the user has moved away from", async () => {
    let resolveOld: (value: AuditDetail) => void = () => {};
    const olderDetail: AuditDetail = {
      ...detail,
      entry: { ...detail.entry, runId: "run-old", actionId: "clear-cache" },
    };
    render(
      <AuditHistory
        loadList={() => Promise.resolve([newer, older])}
        loadDetail={(runId) =>
          runId === "run-old"
            ? new Promise<AuditDetail>((resolve) => {
                resolveOld = resolve;
              })
            : Promise.resolve(detail)
        }
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "clear-cache" }));
    fireEvent.click(screen.getByRole("button", { name: "restart-db" }));
    expect(await screen.findByRole("heading", { level: 3, name: "restart-db" })).toBeInTheDocument();
    await act(async () => resolveOld(olderDetail));
    expect(screen.getByRole("heading", { level: 3, name: "restart-db" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 3, name: "clear-cache" })).toBeNull();
  });

  it("shows a safe not-found status when the detail 404s (undefined)", async () => {
    render(
      <AuditHistory
        loadList={() => Promise.resolve([newer])}
        loadDetail={() => Promise.resolve(undefined)}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "restart-db" }));
    expect(await screen.findByText("That audit entry could not be found.")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("That audit entry could not be found.");
  });

  it("shows a safe alert when the detail load fails", async () => {
    render(
      <AuditHistory
        loadList={() => Promise.resolve([newer])}
        loadDetail={() => Promise.reject(new Error("kaboom"))}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "restart-db" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Failed to load audit entry.");
    expect(document.body).not.toHaveTextContent("kaboom");
  });

  it("defaults its loaders (no injected props) without throwing on mount", () => {
    // Stub fetch so the default client loaders have something to call.
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response("[]", { status: 200 }))));
    expect(() => render(<AuditHistory />)).not.toThrow();
  });
});
