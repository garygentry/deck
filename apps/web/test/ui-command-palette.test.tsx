// @vitest-environment jsdom
// The CommandPalette pattern.
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Button, CommandPalette, type CommandPaletteGroup } from "@/ui";

afterEach(cleanup);

// jsdom lacks APIs Radix Dialog / cmdk use. Stub them for this file only.
const restores: (() => void)[] = [];
beforeAll(() => {
  const g = globalThis as { ResizeObserver?: unknown };
  const previous = g.ResizeObserver;
  g.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
  restores.push(() => {
    g.ResizeObserver = previous;
  });
  const proto = Element.prototype as unknown as Record<string, unknown>;
  if (!("scrollIntoView" in proto)) {
    proto.scrollIntoView = () => {};
    restores.push(() => {
      delete proto.scrollIntoView;
    });
  }
});
afterAll(() => {
  for (const restore of restores.splice(0).reverse()) restore();
});

function groups(onSelect: (id: string) => void = () => {}): CommandPaletteGroup[] {
  return [
    {
      heading: "Pages",
      items: [
        { id: "page:portal", label: "Portal", icon: "layout-grid", onSelect: () => onSelect("page:portal") },
        { id: "page:drift", label: "Drift", icon: "git-compare", onSelect: () => onSelect("page:drift") },
      ],
    },
    {
      heading: "Hosts",
      items: [
        { id: "host:web-01", label: "web-01", hint: "Critical", onSelect: () => onSelect("host:web-01") },
        { id: "host:db-01", label: "db-01", keywords: ["postgres"], onSelect: () => onSelect("host:db-01") },
      ],
    },
  ];
}

/** A trigger button plus a controlled palette. */
function Harness({ items }: { items: CommandPaletteGroup[] }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>Open palette</Button>
      <CommandPalette open={open} onOpenChange={setOpen} groups={items} title="Go to" emptyText="Nothing here" />
    </>
  );
}

const optionNames = () => screen.queryAllByRole("option").map((el) => el.textContent);

describe("CommandPalette", () => {
  it("opens as a dialog named by its title, with data-slot and grouped options", async () => {
    const user = userEvent.setup();
    render(<Harness items={groups()} />);
    expect(screen.queryByRole("dialog")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Open palette" }));
    const dialog = await screen.findByRole("dialog", { name: "Go to" });
    expect(dialog).toHaveAttribute("data-slot", "command-palette");
    expect(screen.getByRole("combobox")).toHaveFocus();
    expect(optionNames()).toEqual(["Portal", "Drift", "web-01Critical", "db-01"]);
    expect(screen.getByRole("group", { name: "Hosts" })).toBeInTheDocument();
  });

  it("filters items on typed text, matching label, hint and keywords but not ids", async () => {
    const user = userEvent.setup();
    render(<Harness items={groups()} />);
    await user.click(screen.getByRole("button", { name: "Open palette" }));
    const input = await screen.findByRole("combobox");

    await user.type(input, "web");
    await waitFor(() => expect(optionNames()).toEqual(["web-01Critical"]));

    await user.clear(input);
    await user.type(input, "postgres");
    await waitFor(() => expect(optionNames()).toEqual(["db-01"]));

    await user.clear(input);
    await user.type(input, "critical");
    await waitFor(() => expect(optionNames()).toEqual(["web-01Critical"]));

    await user.clear(input);
    await user.type(input, "host:");
    await waitFor(() => expect(optionNames()).toEqual([]));
  });

  it("ArrowDown + Enter runs the highlighted item's onSelect, then closes", async () => {
    const user = userEvent.setup();
    const order: string[] = [];
    const onSelect = vi.fn((id: string) => order.push(`select:${id}`));
    function Spy() {
      const [open, setOpen] = useState(true);
      return (
        <CommandPalette
          open={open}
          onOpenChange={(next) => {
            order.push(`open:${next}`);
            setOpen(next);
          }}
          groups={groups(onSelect)}
          title="Go to"
        />
      );
    }
    render(<Spy />);
    const input = await screen.findByRole("combobox");
    input.focus();

    await user.keyboard("{ArrowDown}");
    await waitFor(() => expect(screen.getByRole("option", { name: "Drift" })).toHaveAttribute("aria-selected", "true"));
    await user.keyboard("{Enter}");

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith("page:drift");
    expect(order).toEqual(["select:page:drift", "open:false"]);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("Escape closes the dialog and returns focus to the trigger", async () => {
    const user = userEvent.setup();
    render(<Harness items={groups()} />);
    const trigger = screen.getByRole("button", { name: "Open palette" });
    await user.click(trigger);
    await screen.findByRole("dialog", { name: "Go to" });

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("returns focus to returnFocusTo instead, when given", async () => {
    const user = userEvent.setup();
    function Elsewhere() {
      const [open, setOpen] = useState(false);
      const [target, setTarget] = useState<HTMLElement | null>(null);
      return (
        <>
          <Button ref={setTarget}>Original opener</Button>
          <Button onClick={() => setOpen(true)}>Open palette</Button>
          <CommandPalette open={open} onOpenChange={setOpen} groups={groups()} returnFocusTo={target} />
        </>
      );
    }
    render(<Elsewhere />);
    await user.click(screen.getByRole("button", { name: "Open palette" }));
    await screen.findByRole("dialog");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(screen.getByRole("button", { name: "Original opener" })).toHaveFocus());
  });

  it("opens with the caret after text already in a controlled search field", async () => {
    render(<CommandPalette open onOpenChange={() => {}} groups={groups()} search="we" onSearchChange={() => {}} />);
    const input = (await screen.findByRole("combobox")) as HTMLInputElement;
    await waitFor(() => expect(input).toHaveFocus());
    expect(input.value).toBe("we");
    expect([input.selectionStart, input.selectionEnd]).toEqual([2, 2]);
  });

  it("shows the empty text when nothing matches", async () => {
    const user = userEvent.setup();
    render(<Harness items={groups()} />);
    await user.click(screen.getByRole("button", { name: "Open palette" }));
    await user.type(await screen.findByRole("combobox"), "zzzz");

    await waitFor(() => expect(screen.getByText("Nothing here")).toBeInTheDocument());
    expect(screen.queryAllByRole("option")).toHaveLength(0);
  });

  it("shouldFilter={false} shows the given items in order and reports typed text through onSearchChange", async () => {
    const user = userEvent.setup();
    const seen: string[] = [];
    function Controlled() {
      const [search, setSearch] = useState("");
      return (
        <CommandPalette
          open
          onOpenChange={() => {}}
          groups={groups()}
          search={search}
          onSearchChange={(next) => {
            seen.push(next);
            setSearch(next);
          }}
          shouldFilter={false}
        />
      );
    }
    render(<Controlled />);
    const input = await screen.findByRole("combobox");
    await user.type(input, "zz");
    expect(input).toHaveValue("zz");
    expect(seen.at(-1)).toBe("zz");
    // Nothing matches "zz" by cmdk's filter, but the caller owns filtering: every item stays, in order.
    expect(optionNames()).toEqual(["Portal", "Drift", "web-01Critical", "db-01"]);
  });
});
