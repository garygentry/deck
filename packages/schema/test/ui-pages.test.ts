import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BUILTIN_CONTRIBUTIONS, ComposeError, composeConfig, composeDefault, IDENTITY, resolveOwner, validate } from "../src/index.js";
import { compileSelect, composeChecked, composeDefaultChecked, evaluateSelect, FUNCTION_COSTS, SELECT_LIMITS, selectProblem, utf8Length } from "../src/select.js";
import { Runtime } from "../src/select/jmespath.js";
import type { ConfigContribution } from "../src/types.js";

const base = { schemaVersion: 2, estate: { name: "test" } };
const withPages = (pages: unknown) => ({ ...base, ui: { pages } });
const page = (widgets: unknown[], extra: Record<string, unknown> = {}) => ({
  id: "lab",
  path: "/lab",
  title: "Lab overview",
  sections: [{ title: "Power", columns: 3, widgets }],
  ...extra,
});

/** A module declaring a gauge whose options need a format, and a free-form note. */
const gauges: ConfigContribution = {
  id: "gauges",
  widgetTypes: [
    {
      type: "gauges/dial",
      optionsSchema: {
        type: "object",
        additionalProperties: false,
        required: ["format"],
        properties: { format: { enum: ["percent", "number"] }, max: { type: "number" } },
      },
    },
    { type: "gauges/note" },
  ],
};
const composed = composeConfig([...BUILTIN_CONTRIBUTIONS, gauges], { selectProblem });
const check = (document: unknown, options: Parameters<typeof validate>[1] = {}) => validate(document, { composed, ...options });
const located = (result: ReturnType<typeof validate>) => result.findings.map(({ code, path, severity }) => ({ code, path, severity }));

describe("ui.pages", () => {
  it("accepts a page of sections and widgets", () => {
    const result = check(withPages([
      page([
        { id: "load", type: "gauges/dial", title: "UPS load", source: "ups", select: "load_pct", options: { format: "percent" }, span: 2, rows: 1 },
        { type: "gauges/note", source: { kind: "http-json" }, options: { anything: [1, "two"] } },
      ], { icon: "gauge", nav: { group: "lab", order: 0, label: "Lab" } }),
    ]));
    expect(located(result)).toEqual([]);
    expect(result.classification).toBe(0);
  });

  it.each([
    ["a page without sections", { id: "lab", path: "/lab", title: "Lab", sections: [] }, "/ui/pages/0/sections"],
    ["a dotted page id", page([{ type: "gauges/note" }], { id: "lab.one" }), "/ui/pages/0/id"],
    ["a path with a parameter", page([{ type: "gauges/note" }], { path: "/lab/:id" }), "/ui/pages/0/path"],
    ["a relative path", page([{ type: "gauges/note" }], { path: "lab" }), "/ui/pages/0/path"],
    ["a blank title", page([{ type: "gauges/note" }], { title: "  " }), "/ui/pages/0/title"],
    ["five columns", { ...page([]), sections: [{ title: "Power", columns: 5, widgets: [{ type: "gauges/note" }] }] }, "/ui/pages/0/sections/0/columns"],
    ["a section without widgets", { ...page([]), sections: [{ title: "Power", widgets: [] }] }, "/ui/pages/0/sections/0/widgets"],
    ["a span of five", page([{ type: "gauges/note", span: 5 }]), "/ui/pages/0/sections/0/widgets/0/span"],
    ["seven rows", page([{ type: "gauges/note", rows: 7 }]), "/ui/pages/0/sections/0/widgets/0/rows"],
    ["a type without a module", page([{ type: "dial" }]), "/ui/pages/0/sections/0/widgets/0/type"],
    ["a dotted widget id", page([{ id: "a.b", type: "gauges/note" }]), "/ui/pages/0/sections/0/widgets/0/id"],
    ["a source of another shape", page([{ type: "gauges/note", source: { id: "ups" } }]), "/ui/pages/0/sections/0/widgets/0/source"],
  ])("rejects %s", (_name, value, path) => {
    const result = check(withPages([value]));
    expect(result.classification).toBe(1);
    expect(result.findings.map((item) => item.path)).toContain(path);
  });

  it("rejects a section without a title (every section is a heading)", () => {
    const result = check(withPages([{ ...page([]), sections: [{ widgets: [{ type: "gauges/note" }] }] }]));
    expect(located(result)).toContainEqual({ code: "SCHEMA_REQUIRED_MISSING", path: "/ui/pages/0/sections/0/title", severity: "error" });
  });

  it("checks a widget's options against its type's schema: a bad option is an error at its path", () => {
    const bad = check(withPages([page([{ type: "gauges/dial", options: { format: "kelvin" } }])]));
    expect(bad.classification).toBe(1);
    expect(located(bad)).toContainEqual({ code: "SCHEMA_INVALID", path: "/ui/pages/0/sections/0/widgets/0/options/format", severity: "error" });
    const extra = check(withPages([page([{ type: "gauges/dial", options: { format: "percent", colour: "red" } }])]));
    expect(located(extra)).toContainEqual({ code: "SCHEMA_UNKNOWN_PROPERTY", path: "/ui/pages/0/sections/0/widgets/0/options/colour", severity: "error" });
    // A type whose options require a field needs options.
    const missing = check(withPages([page([{ type: "gauges/dial" }])]));
    expect(located(missing)).toContainEqual({ code: "SCHEMA_REQUIRED_MISSING", path: "/ui/pages/0/sections/0/widgets/0/options", severity: "error" });
    // Another type's options are not checked against this schema.
    expect(check(withPages([page([{ type: "gauges/note", options: { format: "kelvin" } }])])).classification).toBe(0);
  });

  it("reports an unknown widget type as a warning, not a shape error", () => {
    const result = check(withPages([page([{ type: "nobody/gauge", options: { format: "kelvin" } }])]));
    expect(located(result)).toEqual([{ code: "UI_WIDGET_TYPE_UNKNOWN", path: "/ui/pages/0/sections/0/widgets/0/type", severity: "warning" }]);
  });

  it("reports a disabled module's widget type at info, or as a warning when strict", () => {
    const off = composeConfig([...BUILTIN_CONTRIBUTIONS, { ...gauges, disabled: "switched off" }], { selectProblem });
    const document = withPages([page([{ type: "gauges/dial", options: { format: "kelvin" } }])]);
    // An off module's option schema is not applied either.
    expect(located(validate(document, { composed: off }))).toEqual([
      { code: "UI_WIDGET_TYPE_DISABLED", path: "/ui/pages/0/sections/0/widgets/0/type", severity: "info" },
    ]);
    expect(located(validate(document, { composed: off, disabledSections: "strict" }))).toEqual([
      { code: "UI_WIDGET_TYPE_DISABLED", path: "/ui/pages/0/sections/0/widgets/0/type", severity: "warning" },
    ]);
  });

  it("reports a select that does not parse, when composition has the check", () => {
    const document = withPages([page([{ type: "gauges/note", source: "ups", select: "outlets[?state == 'on'" }])]);
    expect(located(check(document))).toEqual([
      { code: "UI_WIDGET_SELECT_INVALID", path: "/ui/pages/0/sections/0/widgets/0/select", severity: "error" },
    ]);
    // The server entry's compositions always check: its default refuses a misspelt function.
    const misspelt = withPages([page([{ type: "core/json", source: "ups", select: "lenght(@)" }])]);
    expect(located(validate(misspelt, { composed: composeDefaultChecked() }))).toEqual([
      { code: "UI_WIDGET_SELECT_INVALID", path: "/ui/pages/0/sections/0/widgets/0/select", severity: "error" },
    ]);
    expect(located(validate(misspelt, { composed: composeChecked([...BUILTIN_CONTRIBUTIONS, gauges]) }))).toHaveLength(1);
    expect(located(check(withPages([page([{ type: "gauges/note", select: "outlets[?state == 'on'].name | [0]" }])])))).toEqual([]);
  });

  it("keeps an explicit widget id out of the positional form", () => {
    const result = check(withPages([page([{ id: "s1w2", type: "gauges/note" }, { type: "gauges/note" }])]));
    expect(located(result)).toContainEqual({ code: "SCHEMA_INVALID", path: "/ui/pages/0/sections/0/widgets/0/id", severity: "error" });
    expect(check(withPages([page([{ id: "s1", type: "gauges/note" }, { id: "w2", type: "gauges/note" }, { id: "s1w", type: "gauges/note" }])])).classification).toBe(0);
  });

  it("checks omitted options as {} against the whole options schema", () => {
    const strict: ConfigContribution = {
      id: "strict",
      widgetTypes: [
        { type: "strict/all-of", optionsSchema: { type: "object", allOf: [{ properties: { unit: { type: "string" } }, required: ["unit"] }] } },
        { type: "strict/ref", optionsSchema: { $defs: { needs: { type: "object", properties: { unit: { type: "string" } }, required: ["unit"] } }, $ref: "#/$defs/needs" } },
        { type: "strict/min", optionsSchema: { type: "object", minProperties: 1 } },
        { type: "strict/loose", optionsSchema: { type: "object", properties: { unit: { type: "string" } } } },
      ],
    };
    const composition = composeConfig([...BUILTIN_CONTRIBUTIONS, strict], { selectProblem });
    for (const type of ["strict/all-of", "strict/ref", "strict/min"]) {
      const result = validate(withPages([page([{ type }])]), { composed: composition });
      expect(located(result), type).toContainEqual({ code: "SCHEMA_REQUIRED_MISSING", path: "/ui/pages/0/sections/0/widgets/0/options", severity: "error" });
      expect(validate(withPages([page([{ type, options: { unit: "W" } }])]), { composed: composition }).classification, type).toBe(0);
    }
    expect(validate(withPages([page([{ type: "strict/loose" }])]), { composed: composition }).classification).toBe(0);
  });

  it("keeps page ids and a page's widget ids unique", () => {
    const pages = check(withPages([page([{ type: "gauges/note" }]), page([{ type: "gauges/note" }], { path: "/lab2" })]));
    expect(located(pages)).toContainEqual({ code: "ID_DUPLICATE", path: "/ui/pages/1", severity: "error" });
    const widgets = check(withPages([
      { ...page([]), sections: [{ title: "A", widgets: [{ id: "w", type: "gauges/note" }] }, { title: "B", widgets: [{ id: "w", type: "gauges/note" }] }] },
      page([{ id: "w", type: "gauges/note" }], { id: "other", path: "/other" }),
    ]));
    expect(located(widgets)).toEqual([{ code: "ID_DUPLICATE", path: "/ui/pages/0/sections/1/widgets/0", severity: "error" }]);
    expect(IDENTITY["ui.pages"]).toEqual(["id"]);
  });

  it("is overlay-owned", () => {
    expect(resolveOwner("ui.pages")).toBe("overlay");
    const result = check(withPages([page([{ type: "gauges/note" }])]), { layer: "base" });
    expect(located(result)).toContainEqual(expect.objectContaining({ code: "LAYER_OVERLAY_KEY_IN_BASE" }));
  });
});

describe("widget type composition", () => {
  it("refuses a type outside the contribution's namespace", () => {
    expect(() => composeConfig([{ id: "gauges", widgetTypes: [{ type: "other/dial" }] }])).toThrow(ComposeError);
    expect(() => composeConfig([{ id: "gauges", widgetTypes: [{ type: "dial" }] }])).toThrow(/gauges\/<name>/);
  });

  it("calls a type one contribution declares twice that contribution's defect (invalid, not a conflict)", () => {
    // Types are namespaced to their contribution, so only one contribution can declare a type.
    const twice: ConfigContribution = { id: "gauges", widgetTypes: [{ type: "gauges/dial" }, { type: "gauges/dial" }] };
    expect(() => composeConfig([twice])).toThrow(expect.objectContaining({ code: "MODULE_MANIFEST_INVALID", message: expect.stringContaining("declared twice") }));
  });

  it("lists the enabled types, and an off module's separately", () => {
    const composition = composeConfig([gauges, { id: "meters", disabled: "off", widgetTypes: [{ type: "meters/bar" }] }]);
    expect([...composition.widgetTypes].sort()).toEqual(["gauges/dial", "gauges/note"]);
    expect([...composition.disabledWidgetTypes]).toEqual([["meters/bar", "meters"]]);
  });
});

describe("@deck/schema/select", () => {
  it("names a parse problem, or none", () => {
    expect(selectProblem("load_pct")).toBeNull();
    expect(selectProblem("a[")).toMatch(/./);
  });

  it("checks every function and its argument count against the engine's table", () => {
    expect(selectProblem("length(outlets)")).toBeNull();
    expect(selectProblem("not_null(a, b, c)")).toBeNull();
    expect(selectProblem("lenght(outlets)")).toBe("unknown function lenght()");
    expect(selectProblem("abs(load, load)")).toBe("abs() takes 1 argument, not 2");
    expect(selectProblem("starts_with(name)")).toBe("starts_with() takes 2 arguments, not 1");
    expect(selectProblem("merge()")).toBe("merge() takes at least 1 argument, not 0");
    // Nested in a projection or a hash multi-select, too.
    expect(selectProblem("outlets[*].{n: upper(name)}")).toBe("unknown function upper()");
  });

  it("refuses an expression past the static limits, so none can multiply without bound", () => {
    const doubling = Array.from({ length: 20 }, () => "[@, @]").join(" | ");
    expect(selectProblem(doubling)).toBe(`it has 20 multi-selects ([…] or {…}); a select may have at most ${SELECT_LIMITS.multiSelects}`);
    expect(selectProblem(Array.from({ length: 8 }, () => "[@, @]").join(" | "))).toBeNull();
    const long = Array.from({ length: 130 }, (_, index) => `a${index}`).join(" || ");
    expect(selectProblem(long)).toMatch(/at most 256/);
    expect(selectProblem("a".repeat(1025))).toBe("it is longer than 1024 characters");
    // The same check rejects the config.
    const result = check(withPages([page([{ type: "gauges/note", source: "ups", select: doubling }])]));
    expect(located(result)).toEqual([{ code: "UI_WIDGET_SELECT_INVALID", path: "/ui/pages/0/sections/0/widgets/0/select", severity: "error" }]);
  });

  it("evaluates a compiled select any number of times, to plain JSON", () => {
    const compiled = compileSelect("outlets[?state == 'on'].name");
    expect(compiled.problem).toBeUndefined();
    const data = { outlets: [{ name: "nas", state: "on" }, { name: "tv", state: "off" }], load: 41.5 };
    expect(evaluateSelect(compiled, data)).toEqual({ value: ["nas"] });
    expect(evaluateSelect(compiled, { outlets: [] })).toEqual({ value: [] });
    expect(evaluateSelect("load", data)).toEqual({ value: 41.5 });
    expect(evaluateSelect("missing", data)).toEqual({ value: null });
    expect(evaluateSelect(compileSelect("a["), data)).toEqual({ error: expect.stringMatching(/./) });
  });

  it("never reads inherited properties, and no key changes a result's prototype", () => {
    const data = JSON.parse('{"__proto__": {"polluted": "yes"}, "a": {"x": 1}, "list": [{"__proto__": {"p": 1}}]}');
    expect(evaluateSelect("constructor", {})).toEqual({ value: null });
    expect(evaluateSelect("a.constructor", data)).toEqual({ value: null });
    expect(evaluateSelect("a.toString", data)).toEqual({ value: null });
    // An own "__proto__" key is data, and stays a key in the result.
    expect(evaluateSelect("polluted", data)).toEqual({ value: null });
    const whole = evaluateSelect("@", data) as { value: Record<string, unknown> };
    expect(Object.getPrototypeOf(whole.value)).toBe(Object.prototype);
    expect(Object.keys(whole.value)).toEqual(["__proto__", "a", "list"]);
    expect(Object.getOwnPropertyDescriptor(whole.value, "__proto__")?.value).toEqual({ polluted: "yes" });
    const merged = evaluateSelect("merge(@, a) | polluted", data);
    expect(merged).toEqual({ value: null });
    const hash = evaluateSelect("{__proto__: a} | x", data);
    expect(hash).toEqual({ value: null });
    const hashed = evaluateSelect("{__proto__: a}", data) as { value: Record<string, unknown> };
    expect(Object.getPrototypeOf(hashed.value)).toBe(Object.prototype);
    expect(Object.getOwnPropertyDescriptor(hashed.value, "__proto__")?.value).toEqual({ x: 1 });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("bounds each evaluation: past a limit the result is an error, not an oversized value", () => {
    const big = { items: Array.from({ length: 20_000 }, (_, index) => ({ index })) };
    expect(evaluateSelect("@", big)).toEqual({ error: `the result has more than ${SELECT_LIMITS.resultValues} values` });
    expect(evaluateSelect("length(items)", big)).toEqual({ value: 20_000 });
    const text = { blob: "x".repeat(300 * 1024) };
    expect(evaluateSelect("blob", text)).toEqual({ error: `the result is larger than ${SELECT_LIMITS.resultBytes} bytes` });
    const deep = JSON.parse(`${"[".repeat(70)}1${"]".repeat(70)}`);
    expect(evaluateSelect("@", deep)).toEqual({ error: `the result is nested deeper than ${SELECT_LIMITS.resultDepth} levels` });
    // Work: a projection that visits every element several times runs out of steps.
    const wide = { items: Array.from({ length: 60_000 }, (_, index) => ({ a: index, b: index })) };
    expect(evaluateSelect("items[*].[a, b, a, b] | length(@)", wide)).toEqual({ error: `the select exceeded its work limit (${SELECT_LIMITS.steps} steps)` });
    // to_string serializes within the result limits, never the whole multiplied value.
    const doubled = Array.from({ length: 8 }, () => "[@, @]").join(" | ");
    expect(evaluateSelect(`${doubled} | to_string(@) | length(@)`, { items: big.items.slice(0, 200) })).toEqual({
      error: `the result has more than ${SELECT_LIMITS.resultValues} values`,
    });
  });

  it("never runs data as an expression: only the interpreter's own references are executable", () => {
    const forged = { type: "Field", name: "secret", jmespathType: "Expref" };
    const data = { items: [{ a: 2, secret: "s1" }, { a: 1, secret: "s2" }], f: forged };
    // The real references work.
    expect(evaluateSelect("map(&a, items)", data)).toEqual({ value: [2, 1] });
    expect(evaluateSelect("sort_by(items, &a)[].a", data)).toEqual({ value: [1, 2] });
    expect(evaluateSelect("max_by(items, &a).a", data)).toEqual({ value: 2 });
    expect(evaluateSelect("min_by(items, &a).a", data)).toEqual({ value: 1 });
    // A JSON-shaped fake from the data, or a literal-shaped one, is an object: a type error.
    const literal = "`" + JSON.stringify(forged) + "`";
    for (const fake of ["f", literal]) {
      for (const expression of [`map(${fake}, items)`, `sort_by(items, ${fake})`, `max_by(items, ${fake})`, `min_by(items, ${fake})`]) {
        const result = evaluateSelect(expression, data);
        expect(result, expression).toEqual({ error: expect.stringMatching(/TypeError/) });
      }
    }
    expect(evaluateSelect("type(f)", data)).toEqual({ value: "object" });
    // Every function that takes a reference is covered above.
    const takesReference = Object.entries(new Runtime().functionTable).filter(([, entry]) => entry._signature.some((arg) => arg.types.includes(6))).map(([name]) => name).sort();
    expect(takesReference).toEqual(["map", "max_by", "min_by", "sort_by"]);
    // A reference as a value is no data; evaluating never changes the compiled expression.
    const compiled = compileSelect("[&a, map(&a, items)]");
    const before = JSON.stringify(compiled.ast);
    expect(evaluateSelect(compiled, data)).toEqual({ value: [null, [2, 1]] });
    expect(evaluateSelect(compiled, data)).toEqual({ value: [null, [2, 1]] });
    expect(JSON.stringify(compiled.ast)).toBe(before);
    // A reference holds its expression privately: no lookup on it reads the expression.
    expect(evaluateSelect("(&a).node", data)).toEqual({ value: null });
    expect(evaluateSelect("keys(&a)", data)).toEqual({ error: expect.stringMatching(/TypeError/) });
  });

  it("charges every built-in function: each one in the engine has a cost row", () => {
    expect(Object.keys(FUNCTION_COSTS).sort()).toEqual(Object.keys(new Runtime().functionTable).sort());
  });

  /** Evaluate and time it: every bounded case must finish well inside a poll. */
  const timed = (expression: string, data: unknown) => {
    const started = performance.now();
    const result = evaluateSelect(expression, data);
    return { result, ms: performance.now() - started };
  };

  it("orders numbers only: comparing lists or objects is null, never a coercion", () => {
    const wide = `[${Array.from({ length: 14 }, () => "@").join(", ")}]`;
    const chain = Array.from({ length: 7 }, () => wide).join(" | ");
    for (const comparator of ["<", "<=", ">", ">="]) {
      const { result, ms } = timed(`${chain} | [0] ${comparator} [1]`, { n: 1 });
      expect(result, comparator).toEqual({ value: null });
      expect(ms, comparator).toBeLessThan(1000);
    }
    expect(evaluateSelect("a < b", { a: 1, b: 2 })).toEqual({ value: true });
    expect(evaluateSelect("a < b", { a: "1", b: "2" })).toEqual({ value: null });
  });

  it("charges an object's truthiness once per object: filters, !, || and && stay within budget", () => {
    const big = Object.fromEntries(Array.from({ length: 60_000 }, (_, index) => [`k${index}`, index]));
    const x = `[${Array.from({ length: 8 }, () => "@").join(", ")}]`;
    // The review's repro: 8^4 references to one 60 000-key object, each tested by a filter.
    const repro = timed(`b | ${x} | ${x}[] | ${x}[] | ${x}[] | [?@] | length(@)`, { b: big });
    expect(repro.ms).toBeLessThan(1000);
    expect(repro.result).toEqual({ value: 4096 });
    const list = Array.from({ length: 2000 }, () => big);
    for (const expression of ["map(&!@, @)", "[*].[@ || `1`][]", "[*].[@ && `1`][]"]) {
      const { result, ms } = timed(expression, list);
      expect(ms, expression).toBeLessThan(1000);
      // A value, or a limit refusing the (2000-fold) result: never an unbounded evaluation.
      if ("error" in result) expect(result.error, expression).toMatch(/^the result /);
    }
    // Distinct big objects are each enumerated, and charged: past the budget it is an error.
    const distinct = Array.from({ length: 10 }, () => ({ ...big }));
    expect(evaluateSelect("[?@] | length(@)", distinct)).toEqual({ error: `the select exceeded its work limit (${SELECT_LIMITS.steps} steps)` });
    expect(evaluateSelect("[?@] | length(@)", [{}, { a: 1 }, {}])).toEqual({ value: 1 });
  });

  it("charges equality per node compared", () => {
    const wide = `[${Array.from({ length: 28 }, () => "@").join(", ")}]`;
    const chain = Array.from({ length: 4 }, () => wide).join(" | ");
    const { result, ms } = timed(`(a | ${chain}) == (b | ${chain})`, { a: [1], b: [1] });
    expect(result).toEqual({ error: `the select exceeded its work limit (${SELECT_LIMITS.steps} steps)` });
    expect(ms).toBeLessThan(2000);
    expect(evaluateSelect("a == b", { a: { x: [1, { y: 2 }] }, b: { x: [1, { y: 2 }] } })).toEqual({ value: true });
  });

  it("compares objects by their own keys, symmetrically", () => {
    const data = JSON.parse('{"p": {"__proto__": {"x": 1}}, "q": {}, "r": {"__proto__": {"x": 1}}, "c": {"constructor": 1}}');
    expect(evaluateSelect("p == q", data)).toEqual({ value: false });
    expect(evaluateSelect("q == p", data)).toEqual({ value: false });
    expect(evaluateSelect("p == r", data)).toEqual({ value: true });
    expect(evaluateSelect("c == q", data)).toEqual({ value: false });
    expect(evaluateSelect("q == c", data)).toEqual({ value: false });
    expect(evaluateSelect("q != c", data)).toEqual({ value: true });
  });

  it("bounds text a function builds before building it", () => {
    const data = { list: Array.from({ length: 4000 }, () => "x".repeat(1000)) };
    const join = timed("join(',', list)", data);
    expect(join.result).toEqual({ error: `the select built more than ${SELECT_LIMITS.stringChars} characters of text` });
    expect(join.ms).toBeLessThan(1000);
    const toString = timed("to_string(list)", data);
    expect(toString.result).toEqual({ error: `the result is larger than ${SELECT_LIMITS.resultBytes} bytes` });
    expect(evaluateSelect("join('-', list[:2])", { list: ["a", "b", "c"] })).toEqual({ value: "a-b" });
    expect(evaluateSelect("reverse(s)", { s: "x".repeat(300 * 1024) })).toEqual({ error: `the select built more than ${SELECT_LIMITS.stringChars} characters of text` });
  });

  it("slices with integers only, charging the slice's length", () => {
    expect(selectProblem("a[::0.5]")).not.toBeNull();
    expect(evaluateSelect("a[::2]", { a: [1, 2, 3, 4, 5] })).toEqual({ value: [1, 3, 5] });
    const big = { a: Array.from({ length: 250_000 }, (_, index) => index) };
    expect(evaluateSelect("length(a[::1])", big)).toEqual({ error: `the select exceeded its work limit (${SELECT_LIMITS.steps} steps)` });
    expect(evaluateSelect("length(a[][])", big)).toEqual({ error: `the select exceeded its work limit (${SELECT_LIMITS.steps} steps)` });
  });

  it("counts a result's size in UTF-8 bytes, keys and escapes included", () => {
    // A string of n two-byte characters serializes to 2n + 2 bytes (its quotes).
    const limit = SELECT_LIMITS.resultBytes;
    const half = (limit - 2) / 2;
    expect(evaluateSelect("s", { s: "é".repeat(half) })).toEqual({ value: "é".repeat(half) });
    expect(evaluateSelect("s", { s: "é".repeat(half + 1) })).toEqual({ error: `the result is larger than ${limit} bytes` });
    // A key of n two-byte characters: {"key":1} is 2n + 6 bytes.
    const keyed = (n: number) => ({ o: { ["é".repeat(n)]: 1 } });
    expect(evaluateSelect("o", keyed((limit - 6) / 2))).toHaveProperty("value");
    expect(evaluateSelect("o", keyed((limit - 6) / 2 + 1))).toEqual({ error: `the result is larger than ${limit} bytes` });
    // Escapes count: a newline is two bytes in JSON.
    expect(utf8Length(JSON.stringify("\n"))).toBe(4);
    expect(utf8Length("€😀")).toBe(7);
  });

  it("is the only module that loads the vendored engine, and the main entry does not reach it", () => {
    const src = fileURLToPath(new URL("../src/", import.meta.url));
    const files = (readdirSync(src, { recursive: true }) as string[]).filter((file) => /\.(ts|js)$/.test(file) && !file.endsWith(".d.ts")).map((file) => join(src, file));
    const importers = files.filter((file) => /from\s+["'][./]*(?:select\/)?jmespath(?:\.js)?["']/.test(readFileSync(file, "utf8")));
    expect(importers.map((file) => relative(src, file))).toEqual(["select.ts"]);
    const selectImporters = files.filter((file) => /from\s+["'][./]*select(?:\.js)?["']/.test(readFileSync(file, "utf8")));
    expect(selectImporters).toEqual([]);
  });
});

describe("the library's default composition", () => {
  it("includes the kernel's widget types", () => {
    expect([...composeDefault().widgetTypes]).toContain("core/json");
    const document = withPages([page([{ type: "core/json", options: { wrap: "yes" } }])]);
    expect(located(validate(document))).toEqual([{ code: "SCHEMA_INVALID", path: "/ui/pages/0/sections/0/widgets/0/options/wrap", severity: "error" }]);
    expect(validate(withPages([page([{ type: "core/json" }])])).findings).toEqual([]);
  });
});

describe("the vendored engine's licence", () => {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  it("ships the Apache-2.0 text beside the engine, and the notice names it as modified", () => {
    const licence = readFileSync(join(root, "packages/schema/src/select/LICENSE"), "utf8");
    expect(licence).toMatch(/^Apache License\s+Version 2\.0, January 2004/);
    expect(licence).toContain("END OF TERMS AND CONDITIONS");
    const notices = readFileSync(join(root, "THIRD_PARTY_NOTICES.md"), "utf8");
    expect(notices).toContain("jmespath.js 0.16.0");
    expect(notices).toContain("Copyright 2014 James Saryerwinnie");
    expect(notices).toContain("packages/schema/src/select/LICENSE");
    expect(notices).toMatch(/Modified:\*\* yes/);
    const header = readFileSync(join(root, "packages/schema/src/select/jmespath.js"), "utf8").slice(0, 2000);
    expect(header).toContain("./LICENSE");
    expect(header).toContain("THIRD_PARTY_NOTICES.md");
    // The package and the image keep both.
    expect((JSON.parse(readFileSync(join(root, "packages/schema/package.json"), "utf8")) as { files: string[] }).files).toContain("src");
    const ignored = readFileSync(join(root, ".dockerignore"), "utf8").split("\n").map((line) => line.trim());
    for (const pattern of ["LICENSE", "*.md", "THIRD_PARTY_NOTICES.md", "src", "packages"]) expect(ignored).not.toContain(pattern);
  });
});
