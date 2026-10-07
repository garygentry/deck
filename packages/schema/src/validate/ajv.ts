import Ajv2020, { type ValidateFunction } from "ajv/dist/2020.js";
import configSchema from "../../schema/deck.schema.json" with { type: "json" };
import snapshotSchema from "../../schema/snapshot.schema.json" with { type: "json" };

const RFC3339 =
  /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|([+-])(\d{2}):(\d{2}))$/;

function isRfc3339DateTime(value: string): boolean {
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

const ajv = new Ajv2020({
  strict: true,
  allErrors: true,
  discriminator: true,
  allowUnionTypes: true,
});

ajv.addFormat("date-time", { type: "string", validate: isRfc3339DateTime });

function relaxRequired(schema: typeof configSchema): typeof configSchema {
  const relaxed = structuredClone(schema);
  delete (relaxed as { $id?: string }).$id;
  relaxed.required = ["schemaVersion"];
  relaxed.$defs.Estate.required = [];
  relaxed.$defs.Host.required = ["name"];
  relaxed.$defs.Service.required = ["host", "name"];
  return relaxed;
}

export const checkConfig: ValidateFunction = ajv.compile(configSchema);
export const checkSnapshot: ValidateFunction = ajv.compile(snapshotSchema);
export const checkOverlay: ValidateFunction = ajv.compile(relaxRequired(configSchema));
