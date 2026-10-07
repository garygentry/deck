// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Button, cn } from "@/ui";

afterEach(cleanup);

describe("@/ui foundation", () => {
  it("renders a Button primitive as an accessible, clickable button", async () => {
    const onClick = vi.fn();
    render(
      <Button variant="outline" size="sm" onClick={onClick}>
        Refresh
      </Button>,
    );

    const button = screen.getByRole("button", { name: "Refresh" });
    expect(button).toHaveAttribute("data-slot", "button");
    await userEvent.click(button);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("renders Button asChild onto the child element", () => {
    render(
      <Button asChild>
        <a href="/hosts">Hosts</a>
      </Button>,
    );

    expect(screen.getByRole("link", { name: "Hosts" })).toHaveAttribute("data-slot", "button");
  });

  it("cn merges conflicting Tailwind utilities, last one wins", () => {
    expect(cn("px-2 py-1", false && "hidden", "px-4")).toBe("py-1 px-4");
  });
});
