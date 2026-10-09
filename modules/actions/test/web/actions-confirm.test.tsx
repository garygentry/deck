// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResolvedParams } from "@deck/contract/actions";
import type { Action } from "../../server/types.js";

import {
  ConfirmStep,
  isRunArmed,
} from "../../web/components/ConfirmStep.js";

afterEach(cleanup);

function makeAction(overrides: Partial<Action> & { id: string }): Action {
  return {
    title: `Title ${overrides.id}`,
    runner: "runner-name",
    confirm: "none",
    ...overrides,
  };
}

function renderStep(props: Partial<Parameters<typeof ConfirmStep>[0]> & { action: Action }) {
  const handlers = {
    onTypedChange: vi.fn(),
    onArm: vi.fn(),
    onRun: vi.fn(),
    onCancel: vi.fn(),
  };
  render(
    <ConfirmStep
      resolvedParams={{}}
      paramsValid={true}
      typedValue=""
      clickArmed={false}
      disabled={false}
      {...handlers}
      {...props}
    />,
  );
  return handlers;
}

// ---------------------------------------------------------------------------
// isRunArmed
// ---------------------------------------------------------------------------

describe("isRunArmed", () => {
  it("none → always armed", () => {
    const action = makeAction({ id: "x", confirm: "none" });
    expect(isRunArmed(action, "", false)).toBe(true);
  });

  it("confirm → armed only when clickArmed", () => {
    const action = makeAction({ id: "x", confirm: "confirm" });
    expect(isRunArmed(action, "", false)).toBe(false);
    expect(isRunArmed(action, "", true)).toBe(true);
  });

  it("typed-confirm → armed only on an EXACT action.id match", () => {
    const action = makeAction({ id: "restart-db", confirm: "typed-confirm" });
    expect(isRunArmed(action, "restart-d", false)).toBe(false); // wrong id
    expect(isRunArmed(action, "restart-db ", false)).toBe(false); // trailing space
    expect(isRunArmed(action, "restart-db", false)).toBe(true); // exact
  });
});

// ---------------------------------------------------------------------------
// ConfirmStep — Run gating requires paramsValid
// ---------------------------------------------------------------------------

describe("ConfirmStep run gating", () => {
  it("disables the Run control while params are invalid, even when armed", () => {
    renderStep({ action: makeAction({ id: "x", confirm: "none" }), paramsValid: false });
    expect(screen.getByRole("button", { name: "Run Title x" })).toBeDisabled();
  });

  it("enables the Run control for a none action with valid params and shows no intent panel", () => {
    const { onRun } = renderStep({ action: makeAction({ id: "x", confirm: "none" }) });
    const run = screen.getByRole("button", { name: "Run Title x" });
    expect(run).toBeEnabled();
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(run);
    expect(onRun).toHaveBeenCalledTimes(1);
  });

  it("confirm mode: Run stays disabled until armed; Arm run raises onArm", () => {
    const action = makeAction({ id: "x", confirm: "confirm" });
    const { onArm } = renderStep({ action });
    expect(screen.getByRole("button", { name: "Run Title x" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Arm run" }));
    expect(onArm).toHaveBeenCalledTimes(1);
    cleanup();
    renderStep({ action, clickArmed: true });
    expect(screen.queryByRole("button", { name: "Arm run" })).toBeNull();
    expect(screen.getByRole("button", { name: "Run Title x" })).toBeEnabled();
  });

  it("disables every control while a run is in flight", () => {
    renderStep({ action: makeAction({ id: "x", confirm: "confirm" }), disabled: true });
    for (const button of screen.getAllByRole("button")) expect(button).toBeDisabled();
  });
});

// ---------------------------------------------------------------------------
// Keyboard: Esc cancels, Enter runs only when armed (keyboard.ts intents)
// ---------------------------------------------------------------------------

describe("ConfirmStep keyboard", () => {
  it("Escape inside the step cancels", () => {
    const { onCancel } = renderStep({ action: makeAction({ id: "x", confirm: "none" }) });
    fireEvent.keyDown(screen.getByRole("button", { name: "Run Title x" }), { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("Enter in a not-yet-matching typed-confirm field never fires a run", () => {
    const action = makeAction({ id: "restart-db", confirm: "typed-confirm" });
    const { onRun } = renderStep({ action, typedValue: "restart" });
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Type restart-db to confirm" }), {
      key: "Enter",
    });
    expect(onRun).not.toHaveBeenCalled();
  });

  it("Enter in a matching typed-confirm field runs", () => {
    const action = makeAction({ id: "restart-db", confirm: "typed-confirm" });
    const { onRun } = renderStep({ action, typedValue: "restart-db" });
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Type restart-db to confirm" }), {
      key: "Enter",
    });
    expect(onRun).toHaveBeenCalledTimes(1);
  });

  it("Enter on Cancel cancels and never runs", async () => {
    const user = userEvent.setup();
    const { onRun, onCancel } = renderStep({ action: makeAction({ id: "x", confirm: "none" }) });
    screen.getByRole("button", { name: "Cancel" }).focus();
    await user.keyboard("{Enter}");
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onRun).not.toHaveBeenCalled();
  });

  it("Enter on Arm run arms without running", async () => {
    const user = userEvent.setup();
    const { onRun, onArm } = renderStep({ action: makeAction({ id: "x", confirm: "confirm" }) });
    screen.getByRole("button", { name: "Arm run" }).focus();
    await user.keyboard("{Enter}");
    expect(onArm).toHaveBeenCalledTimes(1);
    expect(onRun).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Declared-intent panel (confirm / typed-confirm)
// ---------------------------------------------------------------------------

describe("ConfirmStep declared-intent panel", () => {
  const params: ResolvedParams = { host: "db01", count: 3, force: true };
  const action = makeAction({
    id: "restart-db",
    title: "Restart database",
    runner: "restart-playbook",
    confirm: "confirm",
    description: "Restart the primary database",
    target: { host: "db01", service: "postgres" },
  });

  it("shows title, description, runner NAME, target, and resolved params in an alert", () => {
    renderStep({ action, resolvedParams: params });
    const intent = screen.getByRole("alert");
    expect(within(intent).getByRole("heading", { level: 3, name: "Restart database" })).toBeInTheDocument();
    expect(intent).toHaveTextContent("Restart the primary database");
    expect(within(intent).getByText("Runner")).toBeInTheDocument();
    expect(within(intent).getByText("restart-playbook")).toBeInTheDocument();
    expect(within(intent).getByText("db01 · postgres")).toBeInTheDocument();
    const list = within(intent).getByLabelText("Parameters");
    const terms = within(list).getAllByRole("term").map((t) => t.textContent);
    const values = within(list).getAllByRole("definition").map((d) => d.textContent);
    expect(terms).toEqual(["host", "count", "force"]);
    expect(values).toEqual(["db01", "3", "true"]);
  });

  it("never renders a synthesized command line", () => {
    renderStep({ action, resolvedParams: params });
    const text = document.body.textContent ?? "";
    expect(text).not.toContain("--host");
    expect(text).not.toContain("--count");
    expect(text).not.toMatch(/restart-playbook\s+(--|db01|-)/);
    expect(text).not.toContain("$ ");
  });

  it("renders a typed-confirm input naming the exact action id", () => {
    const typed = makeAction({ id: "restart-db", title: "Restart database", confirm: "typed-confirm" });
    const { onTypedChange } = renderStep({ action: typed });
    const input = screen.getByRole("textbox", { name: "Type restart-db to confirm" });
    expect(input).toHaveValue("");
    expect(screen.getByText("restart-db", { selector: "code" })).toBeInTheDocument();
    fireEvent.change(input, { target: { value: "restart-db" } });
    expect(onTypedChange).toHaveBeenCalledWith("restart-db");
  });
});
