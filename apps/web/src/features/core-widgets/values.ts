import { isExternalHref, isSafeHref, numberOf } from "@deck/module-sdk";
import { formatRelative } from "@/ui";

/** How a value reads (a widget's `format` option). */
export type ValueFormat = "text" | "number" | "bytes" | "percent" | "duration" | "relative-time";

/** The options every value-showing descriptor shares: where it is and how it reads. */
export interface FieldOptions {
  /** A key, or keys joined by dots; read as one key when `direct`. */
  field: string;
  /** The field is a key the widget enumerated itself, read as is (`load.avg` is one key then). */
  direct?: boolean;
  label?: string;
  format?: ValueFormat;
  unit?: string;
  statusMap?: string;
}

/** A plain object (not an array): an item a field can be read from. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Text, a number or a boolean: a value a stat, a cell or a badge shows as is. */
export function isScalar(value: unknown): value is string | number | boolean {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

/**
 * A field of an item: a key, or keys joined by dots (`load.avg`), each read as the item's own
 * property (never one it inherits). `undefined` when any step is missing.
 */
export function readField(item: unknown, field: string): unknown {
  let current = item;
  for (const key of field.split(".")) {
    if (!isRecord(current) || !Object.hasOwn(current, key)) return undefined;
    current = current[key];
  }
  return current;
}

/**
 * An item's value for a descriptor: an enumerated key read as is, a configured field as a path.
 * Only own properties are read.
 */
export function readItem(item: Record<string, unknown>, options: Pick<FieldOptions, "field" | "direct">): unknown {
  if (options.direct === true) return Object.hasOwn(item, options.field) ? item[options.field] : undefined;
  return readField(item, options.field);
}

const NUMBER = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
const PERCENT = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });
// Past a billion, grouped digits stop being readable (1e308 is 400 characters): "1.2E15". Below
// what two decimals can show, a non-zero number would read as "0": "5E-4".
const SCIENTIFIC = new Intl.NumberFormat("en-US", { notation: "scientific", maximumFractionDigits: 2 });
const SCIENTIFIC_FROM = 1e9;
const SCIENTIFIC_BELOW = 0.005;

/** A number grouped (`format`), or in scientific notation when it is huge or tiny but not zero. */
function readable(n: number, format: Intl.NumberFormat): string {
  const size = Math.abs(n);
  return size >= SCIENTIFIC_FROM || (size !== 0 && size < SCIENTIFIC_BELOW) ? SCIENTIFIC.format(n) : format.format(n);
}
const BYTE_UNITS = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"] as const;

function bytes(n: number): string {
  let value = Math.abs(n);
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 || value >= 100 ? 0 : 1;
  return `${n < 0 ? "-" : ""}${value.toFixed(digits)} ${BYTE_UNITS[unit]}`;
}

function duration(seconds: number): string {
  const total = Math.round(Math.abs(seconds));
  const parts: Array<[number, string]> = [
    [Math.floor(total / 86_400), "d"],
    [Math.floor((total % 86_400) / 3_600), "h"],
    [Math.floor((total % 3_600) / 60), "m"],
    [total % 60, "s"],
  ];
  const first = parts.findIndex(([amount]) => amount > 0);
  if (first === -1) return "0s";
  // The two largest units are enough to read at a glance ("3d 4h", "5m 12s").
  const shown = parts.slice(first, first + 2).filter(([amount]) => amount > 0);
  return `${seconds < 0 ? "-" : ""}${shown.map(([amount, unit]) => `${amount}${unit}`).join(" ")}`;
}

/**
 * A value as text, by its format: `number` groups digits (scientific past a billion), `bytes` scales by 1024 (KiB, MiB…),
 * `percent` reads a number of 100, `duration` a number of seconds, and `relative-time` an ISO
 * time or epoch milliseconds against `now`. A value its format cannot read (text where a number
 * belongs) reads as given. A unit follows the value. Lists and objects read as compact JSON.
 */
export function formatValue(value: unknown, format: ValueFormat | undefined, unit: string | undefined, now: number): string {
  const text = formatBare(value, format ?? "text", now);
  return unit === undefined || format === "percent" ? text : `${text} ${unit}`;
}

function formatBare(value: unknown, format: ValueFormat, now: number): string {
  if (format === "relative-time") {
    if (typeof value === "string") return formatRelative(value, now);
    // Epoch milliseconds a Date can hold (±8.64e15); anything else reads as given.
    if (typeof value === "number" && Number.isFinite(new Date(value).getTime())) return formatRelative(new Date(value).toISOString(), now);
  }
  const n = numberOf(value);
  if (n !== undefined) {
    switch (format) {
      case "number":
        return readable(n, NUMBER);
      case "bytes":
        return bytes(n);
      case "percent":
        return `${readable(n, PERCENT)}%`;
      case "duration":
        return duration(n);
      default:
        break;
    }
  }
  if (isScalar(value)) return String(value);
  if (value === null || value === undefined) return "";
  return JSON.stringify(value);
}

/**
 * A link a widget may render from data: an http(s) URL, or an absolute path that stays in deck
 * once a browser parses it (`isSafeHref`: never with a space, a control or a backslash); else none.
 */
export function linkOf(value: unknown): { href: string; external: boolean } | undefined {
  if (typeof value !== "string" || !isSafeHref(value)) return undefined;
  return { href: value, external: isExternalHref(value) };
}
