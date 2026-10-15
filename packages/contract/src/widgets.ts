/**
 * The option schemas of deck's own widget types (`core/…`): the UI contract's copy, data only
 * (no imports) so the browser bundle can load it. Config validation composes the schema
 * library's own copy (`CORE_WIDGET_TYPE_SCHEMAS` in `@deck/schema`); a test keeps the two equal.
 * See that list for what each type shows.
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

/**
 * What a framed page may do (`core/embed`). None of these lets it navigate deck's tab, open modals
 * or lock the pointer, except that `allow-popups-to-escape-sandbox` frees the popups it opens.
 */
/**
 * The loose shape of a `core/embed` url (`EMBED_URL_PATTERN` in `@deck/schema/embed`, whose
 * `embedUrlProblem` is the full rule that validation and the renderer run).
 */
const EMBED_URL_PATTERN = "^https?://[^/?#@\\s\\\\]+(?:[/?#][^\\s\\\\]*)?$";

export const EMBED_SANDBOX = ["allow-scripts", "allow-same-origin", "allow-forms", "allow-popups", "allow-popups-to-escape-sandbox", "allow-downloads"] as const;



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
        description: "The values to show, in order; default the object's numbers, text and booleans, by key (the first 24).",
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
        description: "The values to show, in order; default the object's keys (the first 48).",
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
      limit: { type: "integer", minimum: 1, maximum: 200, description: "Tiles shown at most; default 48." },
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
    type: "core/embed",
    optionsSchema: {
      type: "object",
      additionalProperties: false,
      required: ["url"],
      properties: {
        url: {
          type: "string",
          maxLength: 2048,
          pattern: EMBED_URL_PATTERN,
          description: "The http(s) URL of the page the frame shows; never one of deck's own pages.",
        },
        height: { type: "string", enum: ["sm", "md", "lg", "xl"], description: "The frame's height: sm (15rem), md (24rem, default), lg (36rem) or xl (48rem)." },
        sandbox: {
          type: "array",
          maxItems: EMBED_SANDBOX.length,
          uniqueItems: true,
          items: { type: "string", enum: EMBED_SANDBOX },
          description: "What the framed page may do, replacing the default [allow-scripts, allow-same-origin]; [] allows nothing.",
        },
      },
    },
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
