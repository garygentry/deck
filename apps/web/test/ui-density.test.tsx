// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DataTable, EmptyState, List, ListGroup, ListItem, Section, type ColumnDef } from "@/ui";
import { themeCss as THEME_CSS } from "./support/tokens.js";

/**
 * The operator's density (`ui.theme.density`): DataTable, List, ListGroup, Section and
 * EmptyState take their spacing from tokens in theme.css (`py-(--list-item-py)` and the like),
 * which `[data-theme-density="compact"]` tightens. A class a screen passes replaces the token
 * class, so it stays as written under either density. Computed spacing in a real browser is
 * asserted by the `ui-theme` E2E spec.
 */

afterEach(cleanup);

/** The declarations of every top-level `selector { … }` block in theme.css, merged. */
const block = (selector: string): Record<string, string> => {
  const blocks = THEME_CSS.matchAll(new RegExp(`\\n${selector.replace(/[[\]"=]/g, "\\$&")} \\{([^}]*)\\}`, "g"));
  return Object.fromEntries(
    [...blocks].flatMap(([, body]) => [...body!.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map(([, name, value]) => [name!, value!.trim()])),
  );
};

const classes = (element: Element | null): string[] => (element?.getAttribute("class") ?? "").split(/\s+/);
/** The spacing tokens an element's classes read, e.g. `py-(--list-item-py)` → `--list-item-py`. */
const tokensOf = (element: Element | null): string[] =>
  classes(element).flatMap((name) => /^[\w:-]+-\((--[\w-]+)\)$/.exec(name)?.[1] ?? []);

const COLUMNS: ColumnDef<{ name: string }>[] = [{ accessorKey: "name", header: "Host" }];

describe("density spacing tokens", () => {
  it("compact overrides only tokens the default defines, and tightens each one", () => {
    const comfortable = block(":root");
    const compact = block('[data-theme-density="compact"]');
    expect(Object.keys(compact).length).toBeGreaterThan(0);
    const rem = (value: string) => parseFloat(value);
    for (const [token, value] of Object.entries(compact)) {
      expect(comfortable, token).toHaveProperty(token);
      expect(rem(value), token).toBeLessThan(rem(comfortable[token]!));
    }
  });

  it.each(["compact", "comfortable"] as const)("DataTable density=%s reads its cell tokens, and its empty cell too", (density) => {
    const prefix = density === "compact" ? "--table-compact-cell" : "--table-cell";
    const { unmount } = render(<DataTable caption="Hosts" columns={COLUMNS} data={[{ name: "nas-01" }]} getRowId={(row) => row.name} density={density} />);
    for (const cell of [screen.getByRole("columnheader", { name: "Host" }), screen.getByRole("rowheader", { name: "nas-01" })]) {
      expect(tokensOf(cell)).toEqual([`${prefix}-h`, `${prefix}-px`, `${prefix}-py`]);
    }
    unmount();
    render(<DataTable caption="Hosts" columns={COLUMNS} data={[]} getRowId={(row) => row.name} density={density} />);
    expect(tokensOf(screen.getByRole("cell"))).toEqual(["--table-cell-px"]);
  });

  it.each([
    ["plain", ["--list-gap"], ["--list-item-py"]],
    ["divided", [], ["--list-divided-item-py"]],
    ["card", ["--list-card-gap"], ["--list-card-item-px", "--list-card-item-py"]],
  ] as const)("List variant=%s reads its gap and row tokens", (variant, list, item) => {
    render(
      <ListGroup heading="Group">
        <List variant={variant} aria-label="Hosts">
          <ListItem title="nas-01" />
        </List>
      </ListGroup>,
    );
    expect(tokensOf(screen.getByRole("region", { name: "Group" }))).toEqual(["--list-group-gap"]);
    expect(tokensOf(screen.getByRole("list", { name: "Hosts" }))).toEqual([...list]);
    expect(tokensOf(screen.getByRole("listitem"))).toEqual([...item]);
  });

  it("Section and EmptyState read their tokens", () => {
    render(
      <Section title="Power" variant="card">
        <EmptyState title="Nothing yet" />
        <EmptyState compact title="Nothing either" />
      </Section>,
    );
    expect(tokensOf(screen.getByRole("region", { name: "Power" }))).toEqual(["--section-gap", "--section-card-p", "--section-card-p-md"]);
    const [full, compact] = screen.getAllByRole("status");
    expect(tokensOf(full!)).toEqual(["--empty-state-px", "--empty-state-py"]);
    expect(tokensOf(compact!)).toEqual(["--empty-state-compact-py"]);
  });

  it("a screen's own spacing class replaces the token class, so it stays literal under compact", () => {
    render(
      <Section title="Power" variant="card" className="gap-6 p-8">
        <List aria-label="Hosts" className="gap-4">
          <ListItem title="nas-01" className="py-3" />
        </List>
      </Section>,
    );
    const section = screen.getByRole("region", { name: "Power" });
    expect(classes(section)).toEqual(expect.arrayContaining(["gap-6", "p-8"]));
    expect(tokensOf(section)).toEqual(["--section-card-p-md"]);
    expect(tokensOf(screen.getByRole("list", { name: "Hosts" }))).toEqual([]);
    expect(tokensOf(screen.getByRole("listitem"))).toEqual([]);
  });
});
