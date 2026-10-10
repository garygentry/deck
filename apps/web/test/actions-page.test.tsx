// @vitest-environment jsdom
import type { DeckConfig } from "@deck/server";
import type { Action } from "../../../modules/actions/server/types.js";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { JSX } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ConfigState } from "../src/data/hooks.js";

// ActionsPage sources its config through `useConfig()` (via ConfigGate); mocking
// it yields deterministic loading/error/ready views with no poll lifecycle.
let configState: ConfigState;
vi.mock("../src/data/hooks.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/data/hooks.js")>()),
  useConfig: () => configState,
}));

// eslint-disable-next-line import/first
import {
  ActionsPage,
  ActionsPageBoundary,
} from "../../../modules/actions/web/ActionsPage.js";
// eslint-disable-next-line import/first
import { beginRun, failRun, resetRun } from "../../../modules/actions/web/run-store.js";

// ---------------------------------------------------------------------------
// Fixtures. The run store is a real module singleton; cases that need a
// reactive transition drive it through its own exported mutators.
// ---------------------------------------------------------------------------

const ACTION_NONE: Action = {
  id: "echo",
  title: "Echo",
  runner: "echo-runner",
  confirm: "none",
};

const ACTION_CONFIRM: Action = {
  id: "restart-nginx",
  title: "Restart nginx",
  runner: "restart-nginx",
  confirm: "confirm",
  target: { host: "compute-a" },
};

const ACTION_TYPED: Action = {
  id: "backup-db",
  title: "Backup DB",
  runner: "backup-db",
  confirm: "typed-confirm",
};

function readyConfig(actions: readonly Action[]): ConfigState {
  return { status: "ready", config: { modules: { actions: { actions } } } as unknown as DeckConfig };
}

/**
 * Every fetch resolves `{ ok, json }`: the capability probe reads `{ enabled }`
 * and the audit list reads `[]`, so the page settles without the network.
 */
function stubFetch(enabled = true): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      ({
        ok: true,
        status: 200,
        json: async () => (String(url).endsWith("/api/actions") ? { enabled } : []),
      }) as unknown as Response,
    ),
  );
}

function mountPage(enabled = true): void {
  stubFetch(enabled);
  render(<ActionsPage />);
}

const row = (title: string): HTMLElement => screen.getByRole("button", { name: title });

afterEach(() => {
  cleanup();
  resetRun();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Exhaustive `useConfig()` branching under the preserved page heading.
// ---------------------------------------------------------------------------

describe("ActionsPage — useConfig branching", () => {
  it("shows a loading status under the Actions heading while config is loading", () => {
    configState = { status: "loading" };
    mountPage();
    expect(screen.getByRole("heading", { level: 1, name: "Actions" })).toHaveAttribute(
      "id",
      "actions-heading",
    );
    expect(screen.getByRole("status", { name: "Loading actions…" })).toBeInTheDocument();
  });

  it("shows an alert with the config error message", () => {
    configState = { status: "error", message: "estate config is invalid" };
    mountPage();
    expect(screen.getByRole("heading", { level: 1, name: "Actions" })).toBeInTheDocument();
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Failed to load configuration");
    expect(alert).toHaveTextContent("estate config is invalid");
  });

  it("shows the ActionList empty status, never an alert, when no actions are declared", async () => {
    configState = readyConfig([]);
    mountPage();
    expect(screen.getByText("No actions are declared for this deck instance.")).toBeInTheDocument();
    expect(await screen.findByRole("region", { name: "Audit history" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("roots the page in a data-slot", () => {
    configState = readyConfig([]);
    mountPage();
    expect(screen.getByTestId("actions")).toHaveAttribute("data-slot", "actions-page");
  });
});

// ---------------------------------------------------------------------------
// Capability-disabled read-only posture.
// ---------------------------------------------------------------------------

describe("ActionsPage — capability-disabled posture", () => {
  it("shows a read-only banner and mounts no run affordance after an ACTIONS_DISABLED refusal", () => {
    configState = readyConfig([ACTION_NONE]);
    mountPage();

    act(() => {
      beginRun(ACTION_NONE.id);
      failRun({
        code: "ACTIONS_DISABLED",
        message: "The actions capability is disabled on this deck instance.",
      });
    });

    expect(
      screen.getAllByRole("status").some((s) => /actions capability is disabled/.test(s.textContent ?? "")),
    ).toBe(true);
    // No run affordance: rows are read-only, no confirm controls, no form.
    expect(screen.queryByRole("button", { name: ACTION_NONE.title })).toBeNull();
    expect(screen.queryByRole("button", { name: "Arm run" })).toBeNull();
    expect(screen.queryByRole("button", { name: `Run ${ACTION_NONE.title}` })).toBeNull();
    expect(document.querySelector("form")).toBeNull();
  });

  it("flips to the read-only posture when the capability probe reports disabled", async () => {
    configState = readyConfig([ACTION_NONE]);
    mountPage(false);
    expect(
      await screen.findByText("The actions capability is disabled on this deck instance."),
    ).toBeInTheDocument();
    expect(
      await screen.findByText("Audit history is unavailable while the actions capability is disabled."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: ACTION_NONE.title })).toBeNull();
  });
});

describe("ActionsPage — a malformed section while the module is off", () => {
  // Switched off, deck reports a broken `modules.actions` section but still serves it.
  it.each<[string, unknown]>([
    ["actions as an object", { actions: {} }],
    ["actions as a string", { actions: "oops" }],
    ["a null action", { actions: [null] }],
    ["params that are not a list", { actions: [{ ...ACTION_NONE, params: 5 }] }],
    ["a target without a host", { actions: [{ ...ACTION_NONE, target: {} }] }],
    ["the section as a list", [ACTION_NONE]],
  ])("keeps the disabled view, listing nothing, for %s", async (_label, section) => {
    configState = { status: "ready", config: { modules: { actions: section } } as unknown as DeckConfig };
    mountPage(false);
    expect(await screen.findByText("The actions capability is disabled on this deck instance.")).toBeInTheDocument();
    expect(screen.getByText("No actions are declared for this deck instance.")).toBeInTheDocument();
    expect(screen.queryByText(/could not be displayed/i)).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("still lists a well-formed section read-only", async () => {
    configState = readyConfig([ACTION_NONE, ACTION_CONFIRM]);
    mountPage(false);
    expect(await screen.findByText("The actions capability is disabled on this deck instance.")).toBeInTheDocument();
    expect(screen.getByText(ACTION_NONE.title)).toBeInTheDocument();
    expect(screen.getByText(ACTION_CONFIRM.title)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Selection, param form, and arm-reset on selection change (V-020).
// ---------------------------------------------------------------------------

describe("ActionsPage — selection and arming (V-020)", () => {
  it("selecting a row marks it current and shows its confirm step; Cancel deselects", () => {
    configState = readyConfig([ACTION_CONFIRM, ACTION_NONE]);
    mountPage();
    fireEvent.click(row(ACTION_NONE.title));
    expect(row(ACTION_NONE.title)).toHaveAttribute("aria-current", "true");
    expect(screen.getByRole("status")).toHaveTextContent("This action takes no parameters.");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(row(ACTION_NONE.title)).not.toHaveAttribute("aria-current");
    expect(screen.queryByRole("button", { name: `Run ${ACTION_NONE.title}` })).toBeNull();
  });

  it("does not leak an armed 'confirm' state across a subsequent selection", () => {
    configState = readyConfig([ACTION_CONFIRM, ACTION_NONE]);
    mountPage();

    fireEvent.click(row(ACTION_CONFIRM.title));
    fireEvent.click(screen.getByRole("button", { name: "Arm run" }));
    expect(screen.queryByRole("button", { name: "Arm run" })).toBeNull();
    expect(screen.getByRole("button", { name: `Run ${ACTION_CONFIRM.title}` })).toBeEnabled();

    fireEvent.click(row(ACTION_NONE.title));
    fireEvent.click(row(ACTION_CONFIRM.title));
    expect(screen.getByRole("button", { name: "Arm run" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: `Run ${ACTION_CONFIRM.title}` })).toBeDisabled();
  });

  it("does not leak a typed-confirm id across a subsequent selection", () => {
    configState = readyConfig([ACTION_TYPED, ACTION_NONE]);
    mountPage();

    fireEvent.click(row(ACTION_TYPED.title));
    const typed = screen.getByRole("textbox", { name: `Type ${ACTION_TYPED.id} to confirm` });
    expect(typed).toHaveValue("");
    fireEvent.change(typed, { target: { value: ACTION_TYPED.id } });
    expect(typed).toHaveValue(ACTION_TYPED.id);

    fireEvent.click(row(ACTION_NONE.title));
    fireEvent.click(row(ACTION_TYPED.title));
    expect(screen.getByRole("textbox", { name: `Type ${ACTION_TYPED.id} to confirm` })).toHaveValue("");
  });
});

// ---------------------------------------------------------------------------
// Boundary isolation and keyed retry remount.
// ---------------------------------------------------------------------------

describe("ActionsPageBoundary", () => {
  it("isolates a render failure and remounts content on retry", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let shouldThrow = true;
    function Thrower(): JSX.Element {
      if (shouldThrow) throw new Error("boom");
      return <p>Recovered content</p>;
    }

    render(
      <ActionsPageBoundary>
        <Thrower />
      </ActionsPageBoundary>,
    );
    expect(
      screen.getByRole("heading", { name: "Actions view could not be displayed" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("This display failed independently of the server.");
    expect(document.body).not.toHaveTextContent("boom");

    shouldThrow = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry actions view" }));
    expect(screen.getByText("Recovered content")).toBeInTheDocument();
    vi.restoreAllMocks();
  });
});
