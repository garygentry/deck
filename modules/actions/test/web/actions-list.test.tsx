// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Action } from "../../server/types.js";

import {
  ActionList,
  groupActions,
} from "../../web/components/ActionList.js";

afterEach(cleanup);

// ---------------------------------------------------------------------------
// Deterministic action fixtures.
// ---------------------------------------------------------------------------

function makeAction(overrides: Partial<Action> & { id: string }): Action {
  return {
    title: `Title ${overrides.id}`,
    runner: "runner-name",
    confirm: "none",
    ...overrides,
  };
}

const estateA = makeAction({ id: "a", title: "Alpha", description: "Do alpha" });
const estateB = makeAction({ id: "b", title: "Bravo" });
const onZeta = makeAction({
  id: "c",
  title: "Charlie",
  target: { host: "zeta" },
});
const onAlphaHost = makeAction({
  id: "d",
  title: "Delta",
  target: { host: "alpha-host", service: "nginx" },
});

// ---------------------------------------------------------------------------
// groupActions
// ---------------------------------------------------------------------------

describe("groupActions", () => {
  it("puts target-less actions under Estate-wide, first", () => {
    const groups = groupActions([onZeta, estateA]);
    expect(groups[0]?.label).toBe("Estate-wide");
    expect(groups[0]?.host).toBe("");
    expect(groups[0]?.actions.map((a) => a.id)).toEqual(["a"]);
  });

  it("groups by host and orders hosts alphabetically after estate-wide", () => {
    const groups = groupActions([onZeta, onAlphaHost, estateA]);
    expect(groups.map((g) => g.label)).toEqual(["Estate-wide", "alpha-host", "zeta"]);
  });

  it("keeps declared order within a group", () => {
    const groups = groupActions([estateB, estateA]);
    expect(groups[0]?.actions.map((a) => a.id)).toEqual(["b", "a"]);
  });

  it("omits the estate-wide group when every action has a target", () => {
    const groups = groupActions([onZeta, onAlphaHost]);
    expect(groups.map((g) => g.label)).toEqual(["alpha-host", "zeta"]);
  });
});

// ---------------------------------------------------------------------------
// ActionList rendering
// ---------------------------------------------------------------------------

describe("ActionList", () => {
  it("renders a role=status empty state (never alert) when actions is empty", () => {
    render(<ActionList actions={[]} selectedId={null} onSelect={() => {}} />);
    expect(screen.getByRole("status")).toHaveTextContent(
      "No actions are declared for this deck instance.",
    );
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("renders one labelled region per group, with h2 group headings in order", () => {
    render(
      <ActionList
        actions={[estateA, onZeta, onAlphaHost]}
        selectedId={null}
        onSelect={() => {}}
      />,
    );
    const headings = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    expect(headings).toEqual(["Estate-wide", "alpha-host", "zeta"]);
    const zeta = screen.getByRole("region", { name: "zeta" });
    expect(within(zeta).getByRole("button", { name: "Charlie" })).toBeInTheDocument();
  });

  it("names each row by its title and describes it with the description and target", () => {
    render(
      <ActionList actions={[estateA, onAlphaHost]} selectedId={null} onSelect={() => {}} />,
    );
    expect(screen.getByRole("button", { name: "Alpha" })).toHaveAccessibleDescription("Do alpha");
    expect(screen.getByRole("button", { name: "Delta" })).toHaveAccessibleDescription(
      "Target: alpha-host · nginx",
    );
  });

  it("marks only the selected row with aria-current", () => {
    render(<ActionList actions={[estateA, estateB]} selectedId="a" onSelect={() => {}} />);
    expect(screen.getByRole("button", { name: "Alpha" })).toHaveAttribute("aria-current", "true");
    expect(screen.getByRole("button", { name: "Bravo" })).not.toHaveAttribute("aria-current");
  });

  it("raises onSelect with the action on click", async () => {
    const onSelect = vi.fn();
    render(<ActionList actions={[estateA, estateB]} selectedId={null} onSelect={onSelect} />);
    await userEvent.click(screen.getByRole("button", { name: "Bravo" }));
    expect(onSelect).toHaveBeenCalledWith(estateB);
  });

  it("renders read-only rows with no selectable control when readOnly", () => {
    render(<ActionList actions={[estateA]} selectedId="a" onSelect={() => {}} readOnly />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("Alpha")).toBeInTheDocument();
  });
});
