/**
 * Deck's own widget types (`core/…`), which config pages place like any module's: each type and
 * the JSON Schema of its `options`. The library's composition includes them
 * ({@link BUILTIN_CONTRIBUTIONS}). Deck's UI contract declares the same types with their
 * components (`@deck/contract/modules/core`), and deck's tests keep the two equal.
 * - `core/json`: the widget's value as formatted JSON; `wrap` soft-wraps long lines.
 */
export const CORE_WIDGET_TYPE_SCHEMAS = [
  {
    type: "core/json",
    optionsSchema: {
      type: "object",
      additionalProperties: false,
      properties: { wrap: { type: "boolean", description: "Soft-wrap long lines instead of scrolling." } },
    },
  },
] as const;
