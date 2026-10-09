/**
 * Deck's own widget types (`core/…`), which config pages place like any module's: each type and
 * the JSON Schema of its `options`. The library's composition includes them
 * ({@link BUILTIN_CONTRIBUTIONS}). Deck's UI contract (`@deck/contract/modules/core`) declares
 * the same types with their components, from its own copy of these schemas; deck's tests keep
 * the two equal.
 *
 * A widget reads its value (its `select` result, or the provider's data whole) and shows it:
 * - `core/stat`: one number or short text, large;
 * - `core/stat-grid`: several values of an object, each a stat;
 * - `core/meter`: a number against a maximum, as a bar;
 * - `core/key-value`: an object's values as label/value pairs;
 * - `core/list`: a list's items as rows (title, description, meta, status, link);
 * - `core/table`: a list of objects as a table, one column per descriptor;
 * - `core/status-grid`: a list of named states (or an object of name → state) as status tiles;
 * - `core/link-tiles`: links, from `options.links` or from the value;
 * - `core/markdown`: markdown text, from `options.content` or the value, sanitised;
 * - `core/health-pills`: the shell's health pills (`app/topbar.status`); it reads no source;
 * - `core/json`: the value as formatted JSON (`wrap` soft-wraps long lines).
 *
 * `statusMap` names a status map (`ui.statusMaps`): the value's tone. `field` is a key of an
 * item, or keys joined by dots (`load.avg`), never a query: a widget's `select` shapes the data.
 */

const FORMAT = {
  type: "string",
  enum: ["text", "number", "bytes", "percent", "duration", "relative-time"],
  description:
    "How a value reads: text as given (default), number (grouped), bytes (KiB, MiB…), percent (of 100), duration (from seconds) or relative-time (from an ISO time or epoch milliseconds).",
} as const;
const UNIT = { type: "string", minLength: 1, maxLength: 16, description: "Text after the value, such as W or req/s." } as const;
const STATUS_MAP = {
  type: "string",
  pattern: "^[a-z0-9][a-z0-9-]*$",
  maxLength: 64,
  description: "The name of a status map (ui.statusMaps) that gives the value its tone.",
} as const;
const FIELD = {
  type: "string",
  minLength: 1,
  maxLength: 256,
  // Keys only: no brackets, wildcards, pipes or quotes, so a JMESPath query is refused here.
  pattern: "^[^.\\s\\[\\]*|&!?@'\"`(){}]+(?:\\.[^.\\s\\[\\]*|&!?@'\"`(){}]+)*$",
  description: "A key of the item, or keys joined by dots (load.avg); a query belongs in the widget's select.",
} as const;
const LABEL = { type: "string", minLength: 1, maxLength: 80 } as const;
const HREF = {
  type: "string",
  maxLength: 2048,
  pattern: "^(?:https?://[^/\\s]\\S*|/(?![/\\\\])\\S*)$",
  description: "An http(s) URL (it opens in a new tab) or an absolute path in deck.",
} as const;
const ICON = { type: "string", pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$", description: "An icon name from the shell's icon set." } as const;

/** One value of an object: where it is, its label and how it reads. */
const FIELD_ITEM = {
  type: "object",
  additionalProperties: false,
  required: ["field"],
  properties: {
    field: FIELD,
    label: { ...LABEL, description: "The value's label; default its field." },
    format: FORMAT,
    unit: UNIT,
    statusMap: STATUS_MAP,
  },
} as const;

const objectSchema = <P extends Record<string, unknown>>(properties: P) =>
  ({ type: "object", additionalProperties: false, properties }) as const;

export const CORE_WIDGET_TYPE_SCHEMAS = [
  {
    type: "core/stat",
    optionsSchema: objectSchema({
      label: { ...LABEL, description: "The value's label; default the widget's title." },
      format: FORMAT,
      unit: UNIT,
      statusMap: STATUS_MAP,
    }),
  },
  {
    type: "core/stat-grid",
    optionsSchema: objectSchema({
      items: {
        type: "array",
        minItems: 1,
        maxItems: 24,
        items: FIELD_ITEM,
        description: "The values to show, in order; default every number, text and boolean of the object, by key.",
      },
    }),
  },
  {
    type: "core/meter",
    optionsSchema: objectSchema({
      label: { ...LABEL, description: "The meter's label; default the widget's title." },
      max: { type: "number", exclusiveMinimum: 0, description: "The value that fills the bar; default 100." },
      format: { ...FORMAT, description: `${FORMAT.description} Default: the value's percentage of max.` },
      unit: UNIT,
      statusMap: STATUS_MAP,
    }),
  },
  {
    type: "core/key-value",
    optionsSchema: objectSchema({
      items: {
        type: "array",
        minItems: 1,
        maxItems: 48,
        items: FIELD_ITEM,
        description: "The values to show, in order; default every key of the object.",
      },
      layout: { type: "string", enum: ["grid", "stacked", "inline"], description: "grid (default): label beside value; stacked: label above value; inline: pairs along a line." },
    }),
  },
  {
    type: "core/list",
    optionsSchema: objectSchema({
      titleField: { ...FIELD, description: "The field each row's title reads; default name (an item that is text or a number is its own title)." },
      descriptionField: { ...FIELD, description: "The field of a row's secondary line." },
      metaField: { ...FIELD, description: "The field of a row's trailing fact (a time, a count)." },
      metaFormat: FORMAT,
      statusField: { ...FIELD, description: "The field of a row's status, shown as a badge." },
      statusMap: STATUS_MAP,
      hrefField: { ...FIELD, description: "The field of a row's link: an http(s) URL or an absolute path in deck; any other value is not linked." },
      limit: { type: "integer", minimum: 1, maximum: 100, description: "Rows shown at most; default 25." },
    }),
  },
  {
    type: "core/table",
    optionsSchema: {
      type: "object",
      additionalProperties: false,
      required: ["columns"],
      properties: {
        columns: {
          type: "array",
          minItems: 1,
          maxItems: 12,
          description: "The table's columns, in order; the first one's cells are row headers.",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["field"],
            properties: {
              field: FIELD,
              header: { ...LABEL, description: "The column heading; default its field." },
              format: FORMAT,
              unit: UNIT,
              align: { type: "string", enum: ["start", "end"], description: "end right-aligns (numbers); default start." },
              statusMap: STATUS_MAP,
            },
          },
        },
        limit: { type: "integer", minimum: 1, maximum: 500, description: "Rows shown at most; default 100." },
      },
    },
  },
  {
    type: "core/status-grid",
    optionsSchema: objectSchema({
      labelField: { ...FIELD, description: "The field of each tile's name; default name." },
      statusField: { ...FIELD, description: "The field of each tile's state; default status." },
      hrefField: { ...FIELD, description: "The field of each tile's link: an http(s) URL or an absolute path in deck." },
      statusMap: STATUS_MAP,
    }),
  },
  {
    type: "core/link-tiles",
    optionsSchema: objectSchema({
      links: {
        type: "array",
        minItems: 1,
        maxItems: 48,
        description: "The links, in order. Without them the widget shows its value: a list of objects with these same keys.",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["title", "href"],
          properties: {
            title: LABEL,
            href: HREF,
            description: { type: "string", minLength: 1, maxLength: 200 },
            icon: ICON,
          },
        },
      },
    }),
  },
  {
    type: "core/markdown",
    optionsSchema: objectSchema({
      content: { type: "string", minLength: 1, maxLength: 20000, description: "The markdown shown; without it the widget shows its value, which must be text." },
    }),
  },
  {
    type: "core/health-pills",
    optionsSchema: objectSchema({
      pills: {
        type: "array",
        minItems: 1,
        maxItems: 24,
        uniqueItems: true,
        items: { type: "string", pattern: "^pill:[a-z][a-z0-9-]*/[a-z0-9][a-z0-9.-]*$" },
        description: "The pills shown, by extension id (pill:drift/summary); default every pill the top bar shows, in its order.",
      },
    }),
  },
  {
    type: "core/json",
    optionsSchema: objectSchema({
      wrap: { type: "boolean", description: "Soft-wrap long lines instead of scrolling." },
    }),
  },
] as const;

/** A core widget type's name. */
export type CoreWidgetType = (typeof CORE_WIDGET_TYPE_SCHEMAS)[number]["type"];
