import { numberOf } from "@deck/module-sdk";
import { EmptyValue, KeyValueList, Meter, StatGrid, StatTile, VisuallyHidden, useNow, type KeyValueLayout } from "@/ui";

import type { WidgetProps } from "../../registry/registry.js";
import { ToneBadge, toneOf, useStatusMaps } from "./status-maps.js";
import { UnexpectedValue } from "./UnexpectedValue.js";
import { formatValue, isRecord, isScalar, readField, type FieldOptions, type ValueFormat } from "./values.js";

interface ScalarOptions {
  label?: string;
  format?: ValueFormat;
  unit?: string;
  statusMap?: string;
}

/** The widget's own label: the configured one, else its card title for assistive tech only. */
function labelOf(options: { label?: string }, widget: WidgetProps["widget"]) {
  return options.label ?? <VisuallyHidden>{widget.title ?? widget.type}</VisuallyHidden>;
}

/** `now` for relative times, ticking only when a format reads one. */
function useNowFor(formats: ReadonlyArray<ValueFormat | undefined>): number {
  return useNow(15_000, formats.includes("relative-time"));
}

/** `core/stat`: one number or short text, large, toned by its status map. */
export function StatWidget({ value, options, widget }: WidgetProps<ScalarOptions>) {
  const maps = useStatusMaps();
  const now = useNowFor([options.format]);
  if (!isScalar(value)) return <UnexpectedValue type={widget.type} expected="a number or text" value={value} />;
  const presentation = toneOf(maps, options.statusMap)(value);
  return (
    <StatTile
      label={labelOf(options, widget)}
      value={formatValue(value, options.format, options.unit, now)}
      tone={presentation?.tone ?? "neutral"}
      {...(presentation === undefined ? {} : { icon: presentation.icon })}
      className="rounded-none border-y-0 border-r-0 bg-transparent py-1 pr-0"
    />
  );
}

/** The fields to show of an object: the configured ones, else every scalar key, in key order. */
function fieldsOf(value: Record<string, unknown>, items: readonly FieldOptions[] | undefined, scalarsOnly: boolean): FieldOptions[] {
  if (items !== undefined) return [...items];
  return Object.keys(value)
    .filter((key) => !scalarsOnly || isScalar(value[key]))
    .map((field) => ({ field }));
}

/** `core/stat-grid`: several values of an object, each a stat tile. */
export function StatGridWidget({ value, options, widget }: WidgetProps<{ items?: FieldOptions[] }>) {
  const maps = useStatusMaps();
  const now = useNowFor((options.items ?? []).map((item) => item.format));
  if (!isRecord(value)) return <UnexpectedValue type={widget.type} expected="an object" value={value} />;
  return (
    <StatGrid>
      {fieldsOf(value, options.items, true).map((item) => {
        const field = readField(value, item.field);
        const presentation = toneOf(maps, item.statusMap)(field);
        return (
          <StatTile
            key={item.field}
            label={item.label ?? item.field}
            value={field === undefined || field === null ? <EmptyValue>No value</EmptyValue> : formatValue(field, item.format, item.unit, now)}
            tone={presentation?.tone ?? "neutral"}
            {...(presentation === undefined ? {} : { icon: presentation.icon })}
          />
        );
      })}
    </StatGrid>
  );
}

/** `core/meter`: a number against a maximum, as a bar with its value as text. */
export function MeterWidget({ value, options, widget }: WidgetProps<ScalarOptions & { max?: number }>) {
  const maps = useStatusMaps();
  const now = useNowFor([options.format]);
  const number = numberOf(value);
  if (number === undefined) return <UnexpectedValue type={widget.type} expected="a number" value={value} />;
  const max = options.max ?? 100;
  const presentation = toneOf(maps, options.statusMap)(number);
  return (
    <Meter
      label={labelOf(options, widget)}
      value={number}
      max={max}
      tone={presentation?.tone ?? "neutral"}
      {...(presentation === undefined ? {} : { icon: presentation.icon })}
      {...(options.format === undefined ? {} : { valueText: formatValue(number, options.format, options.unit, now) })}
      {...(options.format === undefined || max === 100 ? {} : { srValueText: `${formatValue(number, options.format, options.unit, now)} of ${formatValue(max, options.format, options.unit, now)}` })}
    />
  );
}

/** `core/key-value`: an object's values as label/value pairs; a status map shows a value as a badge. */
export function KeyValueWidget({ value, options, widget }: WidgetProps<{ items?: FieldOptions[]; layout?: KeyValueLayout }>) {
  const maps = useStatusMaps();
  const now = useNowFor((options.items ?? []).map((item) => item.format));
  if (!isRecord(value)) return <UnexpectedValue type={widget.type} expected="an object" value={value} />;
  return (
    <KeyValueList
      layout={options.layout ?? "grid"}
      items={fieldsOf(value, options.items, false).map((item) => {
        const field = readField(value, item.field);
        const text = formatValue(field, item.format, item.unit, now);
        return {
          id: item.field,
          label: item.label ?? item.field,
          value:
            field === undefined || field === null ? (
              <EmptyValue>No value</EmptyValue>
            ) : item.statusMap === undefined ? (
              text
            ) : (
              <ToneBadge text={text} presentation={toneOf(maps, item.statusMap)(field)} />
            ),
        };
      })}
    />
  );
}
