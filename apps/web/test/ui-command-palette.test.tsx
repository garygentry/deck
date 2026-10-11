// @vitest-environment jsdom
// The CommandPalette pattern.
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
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

/** Each option's name: its aria-label when it has a hint, else its text. */
const optionNames = () => screen.queryAllByRole("option").map((el) => el.getAttribute("aria-label") ?? el.textContent);

describe("CommandPalette", () => {
  it("opens as a dialog named by its title, with data-slot and grouped options", async () => {
    const user = userEvent.setup();
    render(<Harness items={groups()} />);
    expect(screen.queryByRole("dialog")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Open palette" }));
    const dialog = await screen.findByRole("dialog", { name: "Go to" });
    expect(dialog).toHaveAttribute("data-slot", "command-palette");
    expect(screen.getByRole("combobox")).toHaveFocus();
    expect(optionNames()).toEqual(["Portal", "Drift", "web-01, Critical", "db-01"]);
    expect(screen.getByRole("group", { name: "Hosts" })).toBeInTheDocument();
    // The hint is announced as a separate phrase, not run into the label.
    expect(screen.getByRole("option", { name: "web-01, Critical" })).toBeInTheDocument();
  });

  it("filters items on typed text, matching label, hint and keywords but not ids", async () => {
    const user = userEvent.setup();
    render(<Harness items={groups()} />);
    await user.click(screen.getByRole("button", { name: "Open palette" }));
    const input = await screen.findByRole("combobox");

    await user.type(input, "web");
    await waitFor(() => expect(optionNames()).toEqual(["web-01, Critical"]));

    await user.clear(input);
    await user.type(input, "postgres");
    await waitFor(() => expect(optionNames()).toEqual(["db-01"]));

    await user.clear(input);
    await user.type(input, "critical");
    await waitFor(() => expect(optionNames()).toEqual(["web-01, Critical"]));

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
    expect(optionNames()).toEqual(["Portal", "Drift", "web-01, Critical", "db-01"]);
  });

  it("searches an item's current label, hint and keywords after they change while open", async () => {
    const user = userEvent.setup();
    const item = (label: string, hint: string, keywords: string[]): CommandPaletteGroup[] => [
      { heading: "Hosts", items: [{ id: "host:stable", label, hint, keywords, onSelect: () => {} }] },
    ];
    const { rerender } = render(
      <CommandPalette open onOpenChange={() => {}} groups={item("Old host", "Healthy", ["rack-a"])} />,
    );
    const input = await screen.findByRole("combobox");
    await user.type(input, "critical");
    await waitFor(() => expect(screen.queryAllByRole("option")).toHaveLength(0));

    // Same id, new text, with the query still in the field.
    rerender(<CommandPalette open onOpenChange={() => {}} groups={item("Renamed host", "Critical", ["rack-b"])} />);
    await waitFor(() => expect(screen.getByRole("option", { name: "Renamed host, Critical" })).toBeInTheDocument());

    for (const [query, hits] of [
      ["healthy", 0],
      ["old host", 0],
      ["rack-a", 0],
      ["renamed", 1],
      ["rack-b", 1],
    ] as const) {
      await user.clear(input);
      await user.type(input, query);
      await waitFor(() => expect(screen.queryAllByRole("option")).toHaveLength(hits));
    }
  });

  it("keeps the highlight on an item, by id, when its text changes", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const make = (hint: string) => groups(onSelect).map((group) => ({
      ...group,
      items: group.items.map((entry) => (entry.id === "host:web-01" ? { ...entry, hint } : entry)),
    }));
    const { rerender } = render(<CommandPalette open onOpenChange={() => {}} groups={make("Critical")} />);
    const input = await screen.findByRole("combobox");
    input.focus();
    await user.keyboard("{ArrowDown}{ArrowDown}");
    await waitFor(() =>
      expect(screen.getByRole("option", { name: "web-01, Critical" })).toHaveAttribute("aria-selected", "true"),
    );

    rerender(<CommandPalette open onOpenChange={() => {}} groups={make("Healthy")} />);
    await waitFor(() =>
      expect(screen.getByRole("option", { name: "web-01, Healthy" })).toHaveAttribute("aria-selected", "true"),
    );
    await user.keyboard("{Enter}");
    expect(onSelect).toHaveBeenCalledWith("host:web-01");
  });

  it("has a labelled Close button that dismisses it and returns focus, even with no results", async () => {
    const user = userEvent.setup();
    render(<Harness items={groups()} />);
    const trigger = screen.getByRole("button", { name: "Open palette" });
    await user.click(trigger);
    const dialog = await screen.findByRole("dialog", { name: "Go to" });
    await user.type(screen.getByRole("combobox"), "zzzz");
    await waitFor(() => expect(screen.queryAllByRole("option")).toHaveLength(0));

    await user.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("renders groups that share a heading, keyed by id or position", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const shared: CommandPaletteGroup[] = [
        { heading: "Hosts", items: [{ id: "a:web", label: "web (a)", onSelect: () => {} }] },
        { heading: "Hosts", items: [{ id: "b:web", label: "web (b)", onSelect: () => {} }] },
        { id: "third", heading: "Hosts", items: [{ id: "c:web", label: "web (c)", onSelect: () => {} }] },
      ];
      render(<CommandPalette open onOpenChange={() => {}} groups={shared} />);
      await screen.findByRole("combobox");
      expect(screen.getAllByRole("group", { name: "Hosts" })).toHaveLength(3);
      expect(optionNames()).toEqual(["web (a)", "web (b)", "web (c)"]);
      expect(errors.mock.calls.some((call) => String(call[0]).includes("same key"))).toBe(false);
    } finally {
      errors.mockRestore();
    }
  });

  it("search without onSearchChange seeds the field, which stays editable", async () => {
    const user = userEvent.setup();
    render(<CommandPalette open onOpenChange={() => {}} groups={groups()} search="we" />);
    const input = await screen.findByRole("combobox");
    expect(input).toHaveValue("we");
    await waitFor(() => expect(optionNames()).toEqual(["web-01, Critical"]));

    await user.type(input, "x");
    expect(input).toHaveValue("wex");
    await user.clear(input);
    expect(input).toHaveValue("");
    await user.type(input, "postgres");
    await waitFor(() => expect(optionNames()).toEqual(["db-01"]));
  });

  it("onSearchChange without search reports typing over an editable field", async () => {
    const user = userEvent.setup();
    const seen: string[] = [];
    render(<CommandPalette open onOpenChange={() => {}} groups={groups()} onSearchChange={(next) => seen.push(next)} />);
    const input = await screen.findByRole("combobox");
    await user.type(input, "db");
    expect(input).toHaveValue("db");
    expect(seen.at(-1)).toBe("db");
  });
});
