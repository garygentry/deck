// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ParamError } from "@deck/contract/actions";
import type { ActionOutcome } from "../../server/types.js";

import { RunOutput } from "../../web/components/RunOutput.js";
import { OUTCOME_UI } from "../../web/status.js";
import type { RunState } from "../../web/run-store.js";
import {
  applyRunEvent,
  beginRun,
  getRunState,
  resetRun,
  subscribeRunState,
} from "../../web/run-store.js";
import { readNdjsonEvents } from "../../web/client.js";

const noop = (): void => {};

afterEach(() => {
  cleanup();
  resetRun();
});

/** Build a terminal RunState for one outcome. */
function terminal(outcome: ActionOutcome, over: Partial<RunState> = {}): RunState {
  return {
    status: "terminal",
    actionId: "act-x",
    runId: outcome === "rejected" ? null : "run-1",
    outcome,
    exit: outcome === "succeeded" ? 0 : outcome === "failed" ? 3 : null,
    durationMs: 1234,
    stdout: "",
    stderr: "",
    ...over,
  } as RunState;
}

/** A reader whose `read()` yields the given chunks in order, then done. */
const encoder = new TextEncoder();
function readerFromChunks(chunks: readonly string[]): ReadableStreamDefaultReader<Uint8Array> {
  let index = 0;
  return {
    read(): Promise<ReadableStreamReadResult<Uint8Array>> {
      if (index < chunks.length) {
        return Promise.resolve({ value: encoder.encode(chunks[index++]!), done: false });
      }
      return Promise.resolve({ value: undefined, done: true });
    },
    releaseLock(): void {},
    cancel(): Promise<void> {
      return Promise.resolve();
    },
    get closed(): Promise<undefined> {
      return Promise.resolve(undefined);
    },
  } as unknown as ReadableStreamDefaultReader<Uint8Array>;
}

/** The terminal banner (the callout carrying `data-outcome`). */
function banner(container: HTMLElement): HTMLElement {
  const found = container.querySelector<HTMLElement>("[data-outcome]");
  if (found === null) throw new Error("no terminal banner");
  return found;
}

// ---------------------------------------------------------------------------
// Distinct terminal state per outcome (one asserting test each).
// ---------------------------------------------------------------------------

describe("RunOutput terminal outcomes", () => {
  const OUTCOMES: readonly ActionOutcome[] = [
    "succeeded",
    "failed",
    "error",
    "rejected",
    "timed-out",
    "cancelled",
  ];

  for (const outcome of OUTCOMES) {
    it(`renders a distinct icon+text banner with the correct role for ${outcome}`, () => {
      const run =
        outcome === "rejected"
          ? terminal(outcome, {
              refusal: { code: "ACTION_UNKNOWN", message: "No such action." },
            } as Partial<RunState>)
          : terminal(outcome);
      const { container } = render(<RunOutput run={run} onCancel={noop} onDismiss={noop} />);
      const ui = OUTCOME_UI[outcome];
      const el = screen.getByRole(ui.role!);
      expect(el).toBe(banner(container));
      expect(el).toHaveAttribute("data-outcome", outcome);
      expect(el).toHaveAttribute("data-tone", ui.tone);
      // Text label is the authoritative signal (never colour-only); the icon is decorative.
      expect(el).toHaveTextContent(ui.label);
      const icon = el.querySelector("svg");
      expect(icon).not.toBeNull();
      expect(icon).toHaveAttribute("aria-hidden", "true");
    });
  }

  it("shows exit code for succeeded/failed and duration for all", () => {
    const { container, rerender } = render(
      <RunOutput run={terminal("succeeded")} onCancel={noop} onDismiss={noop} />,
    );
    expect(banner(container)).toHaveTextContent("Exit code 0");
    rerender(<RunOutput run={terminal("failed")} onCancel={noop} onDismiss={noop} />);
    expect(banner(container)).toHaveTextContent("Exit code 3");
    rerender(<RunOutput run={terminal("timed-out")} onCancel={noop} onDismiss={noop} />);
    expect(banner(container)).toHaveTextContent("1234 ms");
    expect(banner(container)).not.toHaveTextContent("Exit code");
  });

  it("shows captured output under the banner, not busy", () => {
    render(
      <RunOutput
        run={terminal("failed", { stdout: "partial", stderr: "boom" })}
        onCancel={noop}
        onDismiss={noop}
      />,
    );
    const log = screen.getByRole("log");
    expect(log).toHaveTextContent("partial");
    expect(log).toHaveTextContent("Standard error");
    expect(log).toHaveAttribute("aria-busy", "false");
  });
});

// ---------------------------------------------------------------------------
// requesting / idle states.
// ---------------------------------------------------------------------------

describe("RunOutput non-terminal states", () => {
  it("idle renders an unobtrusive, non-error placeholder", () => {
    render(<RunOutput run={{ status: "idle" }} onCancel={noop} onDismiss={noop} />);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("No run in progress.")).toBeInTheDocument();
  });

  it("requesting renders a role=status Starting… with no Cancel yet", () => {
    render(
      <RunOutput run={{ status: "requesting", actionId: "act-x" }} onCancel={noop} onDismiss={noop} />,
    );
    expect(screen.getByRole("status", { name: "Starting…" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancel run" })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Incrementality: multiple stdout renders before the terminal state, driven by
// a chunked reader/store sequence (REQ-STREAM-01/02, REQ-PERF-01).
// ---------------------------------------------------------------------------

describe("RunOutput incrementality", () => {
  it("renders growing stdout across multiple streaming states before terminal", async () => {
    resetRun();
    beginRun("act-x");

    const view = render(<RunOutput run={getRunState()} onCancel={noop} onDismiss={noop} />);
    const streamingOutputs: string[] = [];
    let terminalLabel: string | null = null;
    const unsubscribe = subscribeRunState(() => {
      const state = getRunState();
      view.rerender(<RunOutput run={state} onCancel={noop} onDismiss={noop} />);
      if (state.status === "streaming") {
        const log = screen.getByRole("log");
        expect(log).toHaveAttribute("aria-busy", "true");
        expect(log).toHaveAttribute("aria-live", "polite");
        streamingOutputs.push(
          view.container.querySelector('[data-stream="stdout"]')?.textContent ?? "",
        );
      }
      if (state.status === "terminal") terminalLabel = banner(view.container).textContent;
    });

    // Chunked NDJSON: run, then two stdout chunks (split across a partial line),
    // then the terminal end event.
    const reader = readerFromChunks([
      '{"type":"run","runId":"run-1"}\n',
      '{"type":"stdout","data":"one"}\n{"type":"std',
      'out","data":"two"}\n',
      '{"type":"end","outcome":"succeeded","exit":0,"durationMs":5}\n',
    ]);
    await readNdjsonEvents(reader, applyRunEvent);
    unsubscribe();

    // At least two streaming renders where stdout accumulates monotonically.
    expect(streamingOutputs.filter((out) => out.startsWith("one")).length).toBeGreaterThanOrEqual(2);
    expect(streamingOutputs).toContain("onetwo");
    // The terminal state is reached last and is distinct.
    expect(terminalLabel).toContain(OUTCOME_UI.succeeded.label);
  });
});

// ---------------------------------------------------------------------------
// Cancel + Dismiss controls raise their callbacks.
// ---------------------------------------------------------------------------

describe("RunOutput controls", () => {
  it("the Cancel control raises onCancel(runId) while streaming", () => {
    const onCancel = vi.fn();
    render(
      <RunOutput
        run={{ status: "streaming", actionId: "act-x", runId: "run-42", stdout: "hello", stderr: "" }}
        onCancel={onCancel}
        onDismiss={noop}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel run" }));
    expect(onCancel).toHaveBeenCalledWith("run-42");
  });

  it("streaming shows stderr under a text label (not color) in a busy log", () => {
    render(
      <RunOutput
        run={{ status: "streaming", actionId: "act-x", runId: "run-1", stdout: "out", stderr: "boom" }}
        onCancel={noop}
        onDismiss={noop}
      />,
    );
    const log = screen.getByRole("log");
    expect(log).toHaveAttribute("aria-busy", "true");
    expect(within(log).getByText("Standard error")).toBeInTheDocument();
    expect(within(log).getByText("boom")).toBeInTheDocument();
  });

  it("a rejected terminal shows refusal.message, and PARAMS_INVALID surfaces paramErrors; Dismiss raises onDismiss", () => {
    const paramErrors: readonly ParamError[] = [
      { name: "host", message: '"host" is required.' },
      { name: "count", message: "count must be a number." },
    ];
    const run: RunState = terminal("rejected", {
      refusal: { code: "PARAMS_INVALID", message: "The parameters were invalid.", paramErrors },
    } as Partial<RunState>);
    const onDismiss = vi.fn();
    render(<RunOutput run={run} onCancel={noop} onDismiss={onDismiss} />);

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("The parameters were invalid.");
    const items = within(within(alert).getByRole("list", { name: "Parameter errors" }))
      .getAllByRole("listitem")
      .map((li) => li.textContent);
    expect(items).toEqual(['host: "host" is required.', "count: count must be a number."]);

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("a non-PARAMS_INVALID refusal shows the message but no param error list", () => {
    const run: RunState = terminal("rejected", {
      refusal: { code: "ACTIONS_DISABLED", message: "The actions capability is disabled." },
    } as Partial<RunState>);
    render(<RunOutput run={run} onCancel={noop} onDismiss={noop} />);
    expect(screen.getByRole("alert")).toHaveTextContent("The actions capability is disabled.");
    expect(screen.queryByRole("list", { name: "Parameter errors" })).toBeNull();
  });
});
