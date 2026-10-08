// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DataTable, List, ListItem, Section, type ColumnDef } from "@/ui";

/**
 * The operator's density (`ui.theme.density`): the pre-paint script sets
 * `data-theme-density` on <html>, and DataTable, List and Section carry
 * `density-compact:` classes that tighten their spacing under `compact`. The
 * unprefixed classes, which comfortable (the default) renders, are unchanged.
 * Computed spacing in a real browser is asserted by the `ui-theme` E2E spec.
 */

afterEach(cleanup);

const classes = (element: Element | null): string[] => (element?.getAttribute("class") ?? "").split(/\s+/);

const COLUMNS: ColumnDef<{ name: string }>[] = [{ accessorKey: "name", header: "Host" }];

describe("density-compact wiring", () => {
  it.each([
    ["compact", ["h-8", "px-2", "py-1"], ["density-compact:h-7", "density-compact:py-0.5"]],
    ["comfortable", ["h-11", "px-3", "py-2.5"], ["density-compact:h-8", "density-compact:px-2", "density-compact:py-1"]],
  ] as const)("DataTable density=%s keeps its cells and tightens them under compact", (density, base, compact) => {
    render(<DataTable caption="Hosts" columns={COLUMNS} data={[{ name: "nas-01" }]} getRowId={(row) => row.name} density={density} />);
    for (const cell of [screen.getByRole("columnheader", { name: "Host" }), screen.getByRole("rowheader", { name: "nas-01" })]) {
      expect(classes(cell)).toEqual(expect.arrayContaining([...base, ...compact]));
    }
  });

  it.each([
    ["plain", ["gap-1", "density-compact:gap-0.5"], ["px-2", "py-1.5", "density-compact:py-1"]],
    ["divided", [], ["px-3", "py-2", "density-compact:py-1"]],
    ["card", ["gap-2", "density-compact:gap-1"], ["px-4", "py-3", "density-compact:px-3", "density-compact:py-2"]],
  ] as const)("List variant=%s tightens its rows under compact", (variant, list, item) => {
    render(
      <List variant={variant} aria-label="Hosts">
        <ListItem title="nas-01" />
      </List>,
    );
    expect(classes(screen.getByRole("list", { name: "Hosts" }))).toEqual(expect.arrayContaining([...list]));
    expect(classes(screen.getByRole("listitem"))).toEqual(expect.arrayContaining([...item]));
  });

  it("Section tightens its gap, and a card section its padding, under compact", () => {
    render(
      <Section title="Power" variant="card">
        body
      </Section>,
    );
    expect(classes(screen.getByRole("region", { name: "Power" }))).toEqual(
      expect.arrayContaining(["gap-3", "p-4", "md:p-6", "density-compact:gap-2", "density-compact:p-3", "density-compact:md:p-4"]),
    );
  });
});
