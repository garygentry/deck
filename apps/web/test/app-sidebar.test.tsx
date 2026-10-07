// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SidebarProvider, SidebarTrigger } from "@/ui";
import type { PageRegistration } from "../src/registry/registry-types.js";
import { AppSidebar } from "../src/shell/AppSidebar.js";

const pages: PageRegistration[] = [
  { id: "hosts", path: "/hosts", label: "Hosts", component: () => null },
  { id: "drift", path: "/drift", label: "Drift", component: () => null },
];

function Harness({ path }: { path: string }) {
  return (
    <SidebarProvider>
      <SidebarTrigger />
      <AppSidebar pages={pages} path={path} />
    </SidebarProvider>
  );
}

beforeEach(() => {
  // Phone width: the sidebar renders as a sheet.
  vi.stubGlobal("innerWidth", 375);
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: true, media: query, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("AppSidebar on mobile", () => {
  it("closes the nav sheet when the route changes", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<Harness path="/hosts" />);
    await user.click(screen.getByRole("button", { name: /toggle sidebar/i }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();

    rerender(<Harness path="/drift" />);
    await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});
