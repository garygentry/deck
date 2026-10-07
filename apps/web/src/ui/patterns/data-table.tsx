import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type Column,
  type ColumnDef,
  type Header,
  type RowData,
} from "@tanstack/react-table";
import { useId, type ElementType, type ReactNode } from "react";
import { cn } from "@/ui/lib/utils";
import { EmptyState, type EmptyStateProps } from "@/ui/patterns/empty-state";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/ui/primitives/table";

declare module "@tanstack/react-table" {
  // Per-column presentation hints DataTable reads from `columnDef.meta`.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface ColumnMeta<TData extends RowData, TValue> {
    /** Classes for this column's body cells. */
    className?: string;
    /** Classes for this column's header cell. */
    headerClassName?: string;
    /** `"end"` right-aligns (numbers). */
    align?: "start" | "end";
  }
}

/** The attribute on each row's primary link; `useListNavigation` targets it. */
export const ROW_LINK_ATTRIBUTE = "data-row-link";
/** Selector for every row link in a table: `root.querySelectorAll(ROW_LINK_SELECTOR)`. */
export const ROW_LINK_SELECTOR = `[${ROW_LINK_ATTRIBUTE}]`;

type LinkComponent = ElementType<{ href: string; className?: string; children?: ReactNode }>;

export interface DataTableProps<T> {
  /**
   * TanStack column defs. A def with `columns: [...]` is a group: it renders a
   * two-row header, with the group cell `scope="colgroup"` spanning its leaves.
   * A `cell` renderer is called as a function (no hooks inside it).
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TanStack's own ColumnDef[] idiom
  columns: ColumnDef<T, any>[];
  data: readonly T[];
  /** The table's caption; it also names the scroll region. */
  caption: ReactNode;
  /** Keep the caption for assistive tech but hide it visually. */
  captionHidden?: boolean;
  /** Stable row key (TanStack row id): React key and `data-row-link` value. */
  getRowId: (row: T, index: number) => string;
  /** Makes the first cell's content a link to this href (`data-row-link` = row id). */
  rowLink?: (row: T) => string | undefined;
  /** Link component for `rowLink` (e.g. the router's link); defaults to `<a>`. */
  linkAs?: LinkComponent;
  /** DOM `id` for a row (plus `tabIndex=-1`), so a hash or a script can focus it. */
  rowDomId?: (row: T) => string;
  /** The first column's cells are row headers (`th scope="row"`). Default `true`. */
  rowHeader?: boolean;
  /** Shown in one full-width row when `data` is empty: a title, or full EmptyState props. */
  empty?: ReactNode | Omit<EmptyStateProps, "compact">;
  /** `compact` (default, D16: compact tables) or `comfortable`. */
  density?: "comfortable" | "compact";
  /** Header cells stick to the top of the scroll region (bound its height via `className`). Default `true`. */
  stickyHeader?: boolean;
  /** Classes for the scroll region (the root), e.g. `max-h-96` for a sticky header. */
  className?: string;
}

const isEmptyStateProps = (value: unknown): value is Omit<EmptyStateProps, "compact"> =>
  typeof value === "object" && value !== null && !Array.isArray(value) && "title" in value && !("$$typeof" in value);

function alignClass<T>(column: Column<T, unknown>): string | undefined {
  return column.columnDef.meta?.align === "end" ? "text-right" : undefined;
}

/**
 * A data table over TanStack Table (headless) and the shadcn table primitives.
 * It owns the caption, grouped headers with `scope`, row headers, the row-link
 * convention, the empty row and horizontal scrolling in a focusable, labelled
 * region. Figures are tabular (`tabular-nums`).
 */
export function DataTable<T>({
  columns,
  data,
  caption,
  captionHidden = false,
  getRowId,
  rowLink,
  linkAs: LinkAs = "a",
  rowDomId,
  rowHeader = true,
  empty,
  density = "compact",
  stickyHeader = true,
  className,
}: DataTableProps<T>) {
  const captionId = `${useId().replace(/[^a-zA-Z0-9_-]/g, "")}-caption`;
  const table = useReactTable<T>({
    columns,
    data: data as T[],
    getRowId,
    getCoreRowModel: getCoreRowModel(),
    // No pagination: without this, every `data` change queues a page-index reset
    // (a state update), which re-renders the whole table a second time.
    autoResetPageIndex: false,
  });

  const headerGroups = table.getHeaderGroups();
  const leafColumns = table.getVisibleLeafColumns();
  const firstLeafId = leafColumns[0]?.id;
  const grouped = headerGroups.length > 1;

  // A column appears in several header rows (as placeholders above its real
  // header). Render it once, in its first row, spanning down to its real one.
  const span = (() => {
    const first = new Map<string, number>();
    const real = new Map<string, number>();
    headerGroups.forEach((group, g) =>
      group.headers.forEach((header) => {
        if (!first.has(header.column.id)) first.set(header.column.id, g);
        if (!header.isPlaceholder) real.set(header.column.id, g);
      }),
    );
    return { first, real };
  })();

  const cellPad = density === "compact" ? "h-8 px-2 py-1" : "h-11 px-3 py-2.5";
  const rows = table.getRowModel().rows;
  const emptyProps: Omit<EmptyStateProps, "compact"> = isEmptyStateProps(empty)
    ? empty
    : { title: (empty as ReactNode) ?? "No rows to show" };

  const renderHeader = (header: Header<T, unknown>, g: number): ReactNode => {
    const { column } = header;
    if (span.first.get(column.id) !== g) return null;
    const leaf = column.columns.length === 0;
    const rowSpan = (span.real.get(column.id) ?? g) - g + 1;
    const content = flexRender(column.columnDef.header, header.getContext());
    return (
      <TableHead
        key={header.id}
        scope={leaf ? "col" : "colgroup"}
        colSpan={header.colSpan > 1 ? header.colSpan : undefined}
        rowSpan={rowSpan > 1 ? rowSpan : undefined}
        className={cn(
          cellPad,
          "bg-muted text-xs font-medium text-muted-foreground",
          stickyHeader && "sticky top-0 z-10",
          !leaf && "border-x text-center",
          leaf && alignClass(column),
          column.columnDef.meta?.headerClassName,
        )}
      >
        {content}
      </TableHead>
    );
  };

  return (
    <div
      data-slot="data-table"
      data-density={density}
      role="region"
      aria-labelledby={captionId}
      // Focusable so keyboard users can scroll it horizontally.
      tabIndex={0}
      className={cn(
        "relative w-full overflow-auto rounded-md border outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
        className,
      )}
    >
      <table className="w-full caption-top border-collapse text-sm tabular-nums">
        <caption
          id={captionId}
          className={cn(captionHidden ? "sr-only" : "px-3 py-2 text-left text-sm text-muted-foreground")}
        >
          {caption}
        </caption>
        {grouped ? (
          <>
            {headerGroups[0]!.headers.map((header) => (
              <colgroup key={header.id} span={header.colSpan} />
            ))}
          </>
        ) : null}
        <TableHeader>
          {headerGroups.map((group, g) => (
            <TableRow key={group.id} className="hover:bg-transparent">
              {group.headers.map((header) => renderHeader(header, g))}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {rows.length === 0 ? (
            <TableRow className="hover:bg-transparent">
              <TableCell colSpan={Math.max(1, leafColumns.length)} className="px-3">
                <EmptyState compact {...emptyProps} />
              </TableCell>
            </TableRow>
          ) : (
            rows.map((row) => {
              const href = rowLink?.(row.original);
              return (
                <TableRow
                  key={row.id}
                  id={rowDomId?.(row.original)}
                  tabIndex={rowDomId !== undefined ? -1 : undefined}
                  data-row-id={row.id}
                  className="outline-none focus-visible:bg-muted/50"
                >
                  {row.getVisibleCells().map((cell) => {
                    const { column } = cell;
                    const isFirst = column.id === firstLeafId;
                    // A cell renderer is called as a plain function, not mounted as a
                    // component (which `flexRender` does): a large table then skips
                    // one component instance per cell. Cell renderers must not call
                    // hooks; render a component from the cell when one is needed.
                    const renderCell = column.columnDef.cell;
                    let content: ReactNode =
                      typeof renderCell === "function"
                        ? (renderCell(cell.getContext()) as ReactNode)
                        : flexRender(renderCell, cell.getContext());
                    if (isFirst && href !== undefined) {
                      content = (
                        <LinkAs
                          href={href}
                          className="font-medium text-primary underline-offset-4 outline-none hover:underline focus-visible:rounded-sm focus-visible:ring-[3px] focus-visible:ring-ring/50"
                          {...{ [ROW_LINK_ATTRIBUTE]: row.id }}
                        >
                          {content}
                        </LinkAs>
                      );
                    }
                    const cellClass = cn(cellPad, "text-left", alignClass(column), column.columnDef.meta?.className);
                    return isFirst && rowHeader ? (
                      <th key={cell.id} scope="row" data-slot="table-cell" className={cn("align-middle font-normal whitespace-nowrap", cellClass)}>
                        {content}
                      </th>
                    ) : (
                      <TableCell key={cell.id} className={cellClass}>
                        {content}
                      </TableCell>
                    );
                  })}
                </TableRow>
              );
            })
          )}
        </TableBody>
      </table>
    </div>
  );
}
