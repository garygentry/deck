import Ajv2020, { type ValidateFunction } from "ajv/dist/2020.js";
import snapshotSchema from "../../schema/snapshot.schema.json" with { type: "json" };

const RFC3339 =
  /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|([+-])(\d{2}):(\d{2}))$/;

/**
 * The `date-time` format the schemas validate: RFC 3339 with a `Z` or `±hh:mm` offset and a
 * real calendar date and time.
 */
export function isRfc3339DateTime(value: string): boolean {
  const match = RFC3339.exec(value);
  if (match === null) return false;

  const [, yearText, monthText, dayText, hourText, minuteText, secondText, offsetSign, offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);

  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth[month - 1]!) return false;
  if (hour > 23 || minute > 59 || second > 60) return false;

  if (offsetSign !== undefined) {
    const offsetHour = Number(offsetHourText);
    const offsetMinute = Number(offsetMinuteText);
    if (offsetHour > 23 || offsetMinute > 59) return false;
  }

  return true;
}

/** A fresh Ajv instance with deck's options and formats; one per compiled schema set. */
export function createAjv(): Ajv2020 {
  const ajv = new Ajv2020({
    strict: true,
    allErrors: true,
    discriminator: true,
    allowUnionTypes: true,
  });
  ajv.addFormat("date-time", { type: "string", validate: isRfc3339DateTime });
  return ajv;
}

/**
 * The overlay variant of a composed config schema: an overlay may omit what the base
 * declares, so only `schemaVersion` and the identity fields stay required.
 */
export function relaxRequired<T extends object>(schema: T): T {
  const relaxed = structuredClone(schema) as T & {
    $id?: string;
    required?: string[];
    $defs: Record<string, { required?: string[] }>;
  };
  delete relaxed.$id;
  relaxed.required = ["schemaVersion"];
  relaxed.$defs.Estate!.required = [];
  relaxed.$defs.Host!.required = ["name"];
  relaxed.$defs.Service!.required = ["host", "name"];
  return relaxed;
}

export const checkSnapshot: ValidateFunction = createAjv().compile(snapshotSchema);

/**
 * Why `options` do not satisfy a widget type's options schema, or null: the schema does not
 * compile, or refuses them (the first error). How a module page's declared widgets, which take
 * `{}`, are checked against their types.
 */
export function widgetOptionsProblem(schema: unknown, options: unknown): string | null {
  let accepts: ValidateFunction;
  try {
    accepts = createAjv().compile(schema as object);
  } catch (cause) {
    return `its options schema does not compile: ${(cause as Error).message}`;
  }
  if (accepts(options)) return null;
  const [first] = accepts.errors ?? [];
  return `its type refuses the options ${JSON.stringify(options)}${first === undefined ? "" : ` (${first.instancePath || "/"} ${first.message ?? "is invalid"})`}`;
}
