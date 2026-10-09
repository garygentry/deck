import type { ColumnDef } from "@tanstack/react-table";
import { DataTable, EmptyValue, useNow } from "@/ui";

import type { WidgetProps } from "../../registry/registry.js";
import { ToneBadge, toneOf, useStatusMaps, type ToneOf } from "./status-maps.js";
import { UnexpectedValue } from "./UnexpectedValue.js";
import { formatValue, isRecord, readField, type FieldOptions } from "./values.js";

/** One `columns` descriptor of `core/table`. */
export interface TableColumn extends Omit<FieldOptions, "label"> {
  header?: string;
  align?: "start" | "end";
}

/** A cell: its formatted text, as a status badge when its column names a status map. */
function Cell({ value, column, tone, now }: { value: unknown; column: TableColumn; tone: ToneOf; now: number }) {
  if (value === undefined || value === null) return <EmptyValue>None</EmptyValue>;
  const text = formatValue(value, column.format, column.unit, now);
  return column.statusMap === undefined ? <>{text}</> : <ToneBadge text={text} presentation={tone(value)} />;
}

/**
 * `core/table`: a list of objects as a table, one column per descriptor (`field`, `header`,
 * `format`, `unit`, `align`, `statusMap`), the first column's cells as row headers. The card's
 * title names it (its caption, for assistive tech). Loaded on first use (TanStack Table).
 */
export default function TableWidget({ value, options, widget }: WidgetProps<{ columns: TableColumn[]; limit?: number }>) {
  const maps = useStatusMaps();
  const now = useNow(15_000, options.columns.some((column) => column.format === "relative-time"));
  if (!Array.isArray(value)) return <UnexpectedValue type={widget.type} expected="a list of objects" value={value} />;
  const rows = value.filter(isRecord).slice(0, options.limit ?? 100);
  const columns: ColumnDef<Record<string, unknown>, unknown>[] = options.columns.map((column, index) => {
    const tone = toneOf(maps, column.statusMap);
    return {
      id: `${index}:${column.field}`,
      header: column.header ?? column.field,
      accessorFn: (row) => readField(row, column.field),
      // A plain function of the cell's value: DataTable calls it, so it renders a component.
      cell: (context) => <Cell value={context.getValue()} column={column} tone={tone} now={now} />,
      meta: { align: column.align ?? "start" },
    };
  });
  return (
    <DataTable
      columns={columns}
      data={rows}
      caption={widget.title ?? widget.type}
      captionHidden
      getRowId={(_, index) => String(index)}
      empty="No rows"
      stickyHeader={false}
    />
  );
}
