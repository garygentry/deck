// @vitest-environment jsdom
// Primitives: RadioGroup, Textarea, Kbd, and the Button `loading` state.
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef, useEffect, useState } from "react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Button, Kbd, KbdGroup, RadioGroup, RadioGroupItem, Textarea } from "@/ui";

afterEach(cleanup);

// jsdom lacks ResizeObserver, which Radix RadioGroup (use-size) needs. Stub it for this file only.
let previousResizeObserver: unknown;
beforeAll(() => {
  const g = globalThis as { ResizeObserver?: unknown };
  previousResizeObserver = g.ResizeObserver;
  g.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
});
afterAll(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = previousResizeObserver;
});

describe("RadioGroup", () => {
  function Density({ onValueChange }: { onValueChange?: (value: string) => void }) {
    return (
      <form aria-label="settings">
        <RadioGroup
          aria-label="Density"
          name="density"
          defaultValue="comfortable"
          {...(onValueChange !== undefined ? { onValueChange } : {})}
        >
          <RadioGroupItem value="compact" aria-label="Compact" />
          <RadioGroupItem value="comfortable" aria-label="Comfortable" />
          <RadioGroupItem value="spacious" aria-label="Spacious" />
        </RadioGroup>
      </form>
    );
  }

  it("renders a radiogroup with the default value checked", () => {
    render(<Density />);
    const group = screen.getByRole("radiogroup", { name: "Density" });
    expect(group).toHaveAttribute("data-slot", "radio-group");
    expect(screen.getByRole("radio", { name: "Comfortable" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Compact" })).not.toBeChecked();
    expect(screen.getByRole("radio", { name: "Compact" })).toHaveAttribute("value", "compact");
  });

  it("uses a roving tabindex and selects with the arrow keys", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(<Density onValueChange={onValueChange} />);

    await user.tab();
    const comfortable = screen.getByRole("radio", { name: "Comfortable" });
    expect(comfortable).toHaveFocus();
    expect(screen.getByRole("radio", { name: "Compact" })).toHaveAttribute("tabindex", "-1");

    // Radix checks the item focused while an arrow key is held down; focus moves on a timer.
    await user.keyboard("{ArrowDown>}");
    await waitFor(() => expect(screen.getByRole("radio", { name: "Spacious" })).toHaveFocus());
    await user.keyboard("{/ArrowDown}");
    const spacious = screen.getByRole("radio", { name: "Spacious" });
    expect(spacious).toHaveFocus();
    expect(spacious).toBeChecked();
    expect(onValueChange).toHaveBeenLastCalledWith("spacious");

    await user.keyboard("{ArrowUp>}");
    await waitFor(() => expect(comfortable).toHaveFocus());
    await user.keyboard("{/ArrowUp}");
    expect(comfortable).toBeChecked();
    expect(onValueChange).toHaveBeenLastCalledWith("comfortable");
  });

  it("submits its name/value with the form", async () => {
    const user = userEvent.setup();
    render(<Density />);
    await user.click(screen.getByRole("radio", { name: "Compact" }));
    const form = screen.getByRole("form", { name: "settings" }) as HTMLFormElement;
    const input = form.querySelector('input[name="density"]:checked') as HTMLInputElement | null;
    expect(input?.value).toBe("compact");
  });
});

describe("Textarea", () => {
  it("is a controlled textbox", async () => {
    const user = userEvent.setup();
    const seen: string[] = [];
    function Notes() {
      const [value, setValue] = useState("");
      return (
        <Textarea
          aria-label="Notes"
          value={value}
          onChange={(event) => {
            seen.push(event.target.value);
            setValue(event.target.value.toUpperCase());
          }}
        />
      );
    }
    render(<Notes />);
    const box = screen.getByRole("textbox", { name: "Notes" });
    expect(box.tagName).toBe("TEXTAREA");
    expect(box).toHaveAttribute("data-slot", "textarea");
    await user.type(box, "ab");
    expect(box).toHaveValue("AB");
    expect(seen).toEqual(["a", "Ab"]);
  });
});

describe("Kbd", () => {
  it("renders <kbd> elements, grouped by KbdGroup", () => {
    render(
      <KbdGroup data-testid="combo">
        <Kbd>Ctrl</Kbd>
        <Kbd>K</Kbd>
      </KbdGroup>,
    );
    const key = screen.getByText("K");
    expect(key.tagName).toBe("KBD");
    expect(key).toHaveAttribute("data-slot", "kbd");
    const group = screen.getByTestId("combo");
    expect(group.tagName).toBe("KBD");
    expect(group).toHaveAttribute("data-slot", "kbd-group");
  });

  it("types KbdGroup as a <kbd>, so an HTMLElement ref fits", () => {
    // A `div`-typed KbdGroup would reject this ref at typecheck.
    const ref = createRef<HTMLElement>();
    render(
      <KbdGroup ref={ref}>
        <Kbd>Ctrl</Kbd>
      </KbdGroup>,
    );
    expect(ref.current?.tagName).toBe("KBD");
  });
});

describe("Button loading", () => {
  it("keeps focus, exposes aria-busy/aria-disabled, shows a spinner and swallows clicks", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    const { rerender } = render(<Button onClick={onClick}>Acknowledge</Button>);
    const button = screen.getByRole("button", { name: "Acknowledge" });
    button.focus();
    expect(document.activeElement).toBe(button);

    rerender(
      <Button onClick={onClick} loading>
        Acknowledge
      </Button>,
    );
    const busy = screen.getByRole("button", { name: "Acknowledge" });
    expect(busy).toBe(button);
    expect(document.activeElement).toBe(button);
    expect(busy).not.toHaveAttribute("disabled");
    expect(busy).toHaveAttribute("aria-busy", "true");
    expect(busy).toHaveAttribute("aria-disabled", "true");
    expect(busy).toHaveAttribute("data-loading");
    const spinner = busy.querySelector('[data-slot="button-spinner"]');
    expect(spinner).not.toBeNull();
    expect(spinner).toHaveAttribute("aria-hidden", "true");

    await user.click(busy);
    await user.keyboard("{Enter}");
    expect(onClick).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(button);

    rerender(<Button onClick={onClick}>Acknowledge</Button>);
    await user.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("does not submit its form while loading", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn((event: { preventDefault(): void }) => event.preventDefault());
    render(
      <form onSubmit={onSubmit}>
        <Button type="submit" loading>
          Save
        </Button>
      </form>,
    );
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("leaves a non-loading Button unchanged", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <Button onClick={onClick} loading={false}>
        Refresh
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Refresh" });
    expect(button).not.toHaveAttribute("aria-busy");
    expect(button).not.toHaveAttribute("aria-disabled");
    expect(button).not.toHaveAttribute("data-loading");
    expect(button.querySelector('[data-slot="button-spinner"]')).toBeNull();
    await user.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("animates the spinner only when motion is allowed", () => {
    render(<Button loading>Save</Button>);
    const spinner = screen
      .getByRole("button", { name: "Save" })
      .querySelector('[data-slot="button-spinner"]');
    const classes = spinner?.getAttribute("class")?.split(/\s+/) ?? [];
    expect(classes).toContain("motion-safe:animate-spin");
    expect(classes).not.toContain("animate-spin");
  });

  it("keeps its busy semantics and swallows activation over conflicting forwarded props", async () => {
    const user = userEvent.setup();
    const handlers = {
      onClick: vi.fn(),
      onClickCapture: vi.fn(),
      onKeyDown: vi.fn(),
      onKeyUp: vi.fn(),
      onPointerDown: vi.fn(),
      onMouseDown: vi.fn(),
    };
    render(
      <Button loading aria-busy={false} aria-disabled={false} {...{ "data-loading": undefined }} {...handlers}>
        Save
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Save" });
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).toHaveAttribute("data-loading");
    await user.click(button);
    button.focus();
    await user.keyboard("{Enter}");
    await user.keyboard(" ");
    for (const handler of Object.values(handlers)) expect(handler).not.toHaveBeenCalled();
  });

  it.each(["icon", "icon-sm", "icon-xs"] as const)(
    "shows only the spinner in a %s-size button while loading",
    (size) => {
      const { rerender } = render(
        <Button size={size} aria-label="Copy">
          <svg data-testid="glyph" />
        </Button>,
      );
      const button = screen.getByRole("button", { name: "Copy" });
      expect(screen.getByTestId("glyph")).toBeInTheDocument();
      rerender(
        <Button size={size} aria-label="Copy" loading>
          <svg data-testid="glyph" />
        </Button>,
      );
      expect(screen.queryByTestId("glyph")).toBeNull();
      expect(button.querySelectorAll("svg")).toHaveLength(1);
      expect(button.querySelector('[data-slot="button-spinner"]')).not.toBeNull();
    },
  );

  it("does not remount a text button's stateful children when loading toggles", async () => {
    const user = userEvent.setup();
    let mounts = 0;
    function Counter() {
      const [count, setCount] = useState(0);
      useEffect(() => {
        mounts += 1;
      }, []);
      return (
        <span data-testid="count" onClick={() => setCount((c) => c + 1)}>
          {count}
        </span>
      );
    }
    const { rerender } = render(
      <Button>
        <Counter />
      </Button>,
    );
    await user.click(screen.getByTestId("count"));
    expect(screen.getByTestId("count")).toHaveTextContent("1");
    rerender(
      <Button loading>
        <Counter />
      </Button>,
    );
    rerender(
      <Button>
        <Counter />
      </Button>,
    );
    expect(screen.getByTestId("count")).toHaveTextContent("1");
    expect(mounts).toBe(1);
  });

  it("looks inert while loading: progress cursor, dimmed, no hover change", () => {
    const classesOf = (name: string) =>
      screen.getByRole("button", { name }).getAttribute("class")?.split(/\s+/) ?? [];
    render(
      <>
        <Button loading>Primary</Button>
        <Button variant="ghost" loading>
          Ghost
        </Button>
        <Button variant="ghost">Idle</Button>
      </>,
    );
    const primary = classesOf("Primary");
    expect(primary).toEqual(
      expect.arrayContaining(["data-[loading]:cursor-progress", "data-[loading]:opacity-70"]),
    );
    expect(primary).toContain("hover:bg-primary");
    expect(primary).not.toContain("hover:bg-primary/90");
    const ghost = classesOf("Ghost");
    expect(ghost).not.toContain("hover:bg-accent");
    expect(ghost).toContain("hover:bg-transparent");
    expect(classesOf("Idle")).toContain("hover:bg-accent");
  });
});
