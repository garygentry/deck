import { numberOf } from "@deck/module-sdk";
import { EmptyValue, KeyValueList, Meter, StatGrid, StatTile, VisuallyHidden, useNow, type KeyValueLayout } from "@/ui";

import type { WidgetProps } from "../../registry/registry.js";
import { ToneBadge, toneOf, useStatusMaps } from "./status-maps.js";
import { UnexpectedValue } from "./UnexpectedValue.js";
import { Truncated } from "./Truncated.js";
import { formatValue, isRecord, isScalar, readItem, type FieldOptions, type ValueFormat } from "./values.js";

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

/**
 * The fields to show of an object: the configured ones (paths), else its keys in key order (each
 * read as one key, dots and all), scalars only when `scalarsOnly`, the first `cap` of them.
 */
function fieldsOf(
  value: Record<string, unknown>,
  items: readonly FieldOptions[] | undefined,
  scalarsOnly: boolean,
  cap: number,
): { fields: FieldOptions[]; total: number } {
  if (items !== undefined) return { fields: [...items], total: items.length };
  const keys = Object.keys(value).filter((key) => !scalarsOnly || isScalar(value[key]));
  return { fields: keys.slice(0, cap).map((field) => ({ field, direct: true })), total: keys.length };
}

/** Whether a field holds nothing to show (and so takes no tone). */
const isMissing = (value: unknown): value is null | undefined => value === undefined || value === null;

/** `core/stat-grid`: several values of an object, each a stat tile. */
export function StatGridWidget({ value, options, widget }: WidgetProps<{ items?: FieldOptions[] }>) {
  const maps = useStatusMaps();
  const now = useNowFor((options.items ?? []).map((item) => item.format));
  if (!isRecord(value)) return <UnexpectedValue type={widget.type} expected="an object" value={value} />;
  const { fields, total } = fieldsOf(value, options.items, true, 24);
  return (
    <>
      <StatGrid>
        {fields.map((item, index) => {
          const field = readItem(value, item);
          // A missing value is "No value", never toned (a catch-all rule would otherwise colour it).
          const presentation = isMissing(field) ? undefined : toneOf(maps, item.statusMap)(field);
          return (
            <StatTile
              key={`${index}:${item.field}`}
              label={item.label ?? item.field}
              value={isMissing(field) ? <EmptyValue>No value</EmptyValue> : formatValue(field, item.format, item.unit, now)}
              tone={presentation?.tone ?? "neutral"}
              {...(presentation === undefined ? {} : { icon: presentation.icon })}
            />
          );
        })}
      </StatGrid>
      <Truncated shown={fields.length} total={total} noun="values" />
    </>
  );
}

/**
 * A meter's text: its `format` (a unit after it), else its `unit` after the number, else its
 * percentage of `max` (or "value of max" when that ratio is not a finite number). Never clamped:
 * a value past the bar reads as it is.
 */
function meterText(value: number, max: number, options: ScalarOptions, now: number): { text: string; sr: string } {
  if (options.format === undefined && options.unit === undefined) {
    const percent = (value / max) * 100;
    // A ratio past a number's range (a huge value, a tiny max) reads as the value against its max.
    if (!Number.isFinite(percent)) {
      const text = `${formatValue(value, "number", undefined, now)} of ${formatValue(max, "number", undefined, now)}`;
      return { text, sr: text };
    }
    const text = formatValue(percent, "percent", undefined, now);
    return { text, sr: text };
  }
  const format = options.format ?? "number";
  const text = formatValue(value, format, options.unit, now);
  // A percent reads on its own ("250%"); any other text against its maximum ("180 W of 200 W").
  return { text, sr: format === "percent" ? text : `${text} of ${formatValue(max, format, options.unit, now)}` };
}

/** `core/meter`: a number against a maximum, as a bar with its value as text. */
export function MeterWidget({ value, options, widget }: WidgetProps<ScalarOptions & { max?: number }>) {
  const maps = useStatusMaps();
  const now = useNowFor([options.format]);
  const number = numberOf(value);
  if (number === undefined) return <UnexpectedValue type={widget.type} expected="a number" value={value} />;
  const max = options.max ?? 100;
  // The map reads the value as given ("01" can have its own entry), not the number it reads as.
  const presentation = toneOf(maps, options.statusMap)(value);
  const { text, sr } = meterText(number, max, options, now);
  return (
    <Meter
      label={labelOf(options, widget)}
      value={number}
      max={max}
      tone={presentation?.tone ?? "neutral"}
      {...(presentation === undefined ? {} : { icon: presentation.icon })}
      valueText={text}
      srValueText={sr}
    />
  );
}

/** `core/key-value`: an object's values as label/value pairs; a status map shows a value as a badge. */
export function KeyValueWidget({ value, options, widget }: WidgetProps<{ items?: FieldOptions[]; layout?: KeyValueLayout }>) {
  const maps = useStatusMaps();
  const now = useNowFor((options.items ?? []).map((item) => item.format));
  if (!isRecord(value)) return <UnexpectedValue type={widget.type} expected="an object" value={value} />;
  const { fields, total } = fieldsOf(value, options.items, false, 48);
  return (
    <>
      <KeyValueList
        layout={options.layout ?? "grid"}
        items={fields.map((item, index) => {
          const field = readItem(value, item);
          const text = formatValue(field, item.format, item.unit, now);
          return {
            id: `${index}:${item.field}`,
            label: item.label ?? item.field,
            value: isMissing(field) ? (
              <EmptyValue>No value</EmptyValue>
            ) : item.statusMap === undefined ? (
              text
            ) : (
              <ToneBadge text={text} presentation={toneOf(maps, item.statusMap)(field)} />
            ),
          };
        })}
      />
      <Truncated shown={fields.length} total={total} noun="values" />
    </>
  );
}
