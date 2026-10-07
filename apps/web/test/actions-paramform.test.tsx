// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { validateActionParams } from "@deck/contract/actions";
import type { ParamError } from "@deck/contract/actions";
import type { Action } from "@deck/server/actions";

import {
  ParamForm,
  initialParamValues,
} from "../src/features/governed-actions/components/ParamForm.js";

afterEach(cleanup);

function makeAction(overrides: Partial<Action> & { id: string }): Action {
  return {
    title: `Title ${overrides.id}`,
    runner: "runner-name",
    confirm: "none",
    ...overrides,
  };
}

const typedAction = makeAction({
  id: "typed",
  params: [
    { name: "host", type: "string", required: true, description: "The host to act on" },
    { name: "count", type: "number", default: 3 },
    { name: "force", type: "boolean", default: false },
    { name: "mode", type: "enum", values: ["safe", "hard"], default: "safe" },
  ],
});

function renderForm(
  props: Partial<Parameters<typeof ParamForm>[0]> = {},
): ReturnType<typeof render> {
  return render(
    <ParamForm
      action={typedAction}
      values={initialParamValues(typedAction)}
      onChange={() => {}}
      errors={[]}
      {...props}
    />,
  );
}

// ---------------------------------------------------------------------------
// initialParamValues
// ---------------------------------------------------------------------------

describe("initialParamValues", () => {
  it("seeds each param with its declared default and omits defaultless params", () => {
    expect(initialParamValues(typedAction)).toEqual({
      count: 3,
      force: false,
      mode: "safe",
    });
  });

  it("returns an empty map for an action with no params", () => {
    expect(initialParamValues(makeAction({ id: "bare" }))).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// ParamForm rendering
// ---------------------------------------------------------------------------

describe("ParamForm", () => {
  it("renders the correct labelled control per ActionParam.type", () => {
    renderForm();
    expect(screen.getByRole("textbox", { name: /^host/ })).toHaveAttribute("type", "text");
    expect(screen.getByRole("spinbutton", { name: "count" })).toHaveValue(3);
    expect(screen.getByRole("checkbox", { name: "force" })).not.toBeChecked();
    const mode = screen.getByRole("combobox", { name: "mode" });
    expect(mode).toHaveValue("safe");
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["safe", "hard"]);
  });

  it("offers an empty placeholder option for an enum with no value", () => {
    renderForm({ values: {} });
    expect(screen.getByRole("combobox", { name: "mode" })).toHaveValue("");
    expect(screen.getByRole("option", { name: "Select a value…" })).toBeInTheDocument();
  });

  it("says so when the action takes no parameters", () => {
    render(
      <ParamForm action={makeAction({ id: "bare" })} values={{}} onChange={() => {}} errors={[]} />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("This action takes no parameters.");
  });

  it("marks required params with aria-required and a visible text marker", () => {
    renderForm();
    const host = screen.getByRole("textbox", { name: "host (required)" });
    expect(host).toHaveAttribute("aria-required", "true");
    expect(screen.getByRole("spinbutton", { name: "count" })).not.toHaveAttribute("aria-required");
  });

  it("describes a field by its declared description", () => {
    renderForm();
    expect(screen.getByRole("textbox", { name: /^host/ })).toHaveAccessibleDescription(
      "The host to act on",
    );
  });

  it("renders per-field validateActionParams messages with aria-invalid and a linked alert", () => {
    // A required string is absent → validateActionParams reports it.
    const result = validateActionParams(typedAction, { count: 3, force: false, mode: "safe" });
    expect(result.ok).toBe(false);
    const errors: readonly ParamError[] = result.ok ? [] : result.errors;
    const message = errors.find((e) => e.name === "host")?.message;
    expect(message).toMatch(/is required\./);

    renderForm({ values: { count: 3, force: false, mode: "safe" }, errors });
    const host = screen.getByRole("textbox", { name: /^host/ });
    expect(host).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("alert")).toHaveTextContent(message!);
    expect(host).toHaveAccessibleDescription(`The host to act on ${message}`);
    // Valid fields stay unmarked.
    expect(screen.getByRole("spinbutton", { name: "count" })).not.toHaveAttribute("aria-invalid");
  });

  it("raises onChange with the typed raw values", async () => {
    const onChange = vi.fn();
    renderForm({ onChange });
    await userEvent.type(screen.getByRole("textbox", { name: /^host/ }), "x");
    expect(onChange).toHaveBeenLastCalledWith("host", "x");
    await userEvent.click(screen.getByRole("checkbox", { name: "force" }));
    expect(onChange).toHaveBeenLastCalledWith("force", true);
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "mode" }), "hard");
    expect(onChange).toHaveBeenLastCalledWith("mode", "hard");
  });

  it("disables all inputs when disabled", () => {
    renderForm({ disabled: true });
    expect(screen.getByRole("textbox", { name: /^host/ })).toBeDisabled();
    expect(screen.getByRole("spinbutton", { name: "count" })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: "force" })).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "mode" })).toBeDisabled();
  });
});
