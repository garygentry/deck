import { describe, expect, it } from "vitest";

import { canonicalJson } from "../src/index.js";

describe("canonicalJson", () => {
  it("sorts keys at every depth, keeps array order, indents two spaces and ends in a newline", () => {
    const text = canonicalJson({ b: [{ z: 1, a: 2 }, 3], a: { d: null, c: "x" } });
    expect(text).toBe(
      '{\n  "a": {\n    "c": "x",\n    "d": null\n  },\n  "b": [\n    {\n      "a": 2,\n      "z": 1\n    },\n    3\n  ]\n}\n',
    );
  });

  it("gives the same text for values that differ only in key order", () => {
    expect(canonicalJson({ x: 1, y: { p: true, q: [] } })).toBe(canonicalJson({ y: { q: [], p: true }, x: 1 }));
    expect(canonicalJson({ x: 1 })).not.toBe(canonicalJson({ x: 2 }));
  });

  it("renders primitives and empty containers", () => {
    expect(canonicalJson([])).toBe("[]\n");
    expect(canonicalJson({})).toBe("{}\n");
    expect(canonicalJson("s")).toBe('"s"\n');
  });
});

describe("canonicalJson with own __proto__ keys", () => {
  const cases = {
    "top level": '{"__proto__":{"t":"x"},"x":1}',
    nested: '{"a":{"b":{"__proto__":{"t":"x"},"y":2}}}',
    "inside an array": '{"list":[{"__proto__":[1,2]},{"__proto__":null}]}',
  };

  it.each(Object.entries(cases))("keeps the key and round-trips (%s)", (_, text) => {
    const out = canonicalJson(JSON.parse(text));
    expect(out).toContain('"__proto__"');
    expect(canonicalJson(JSON.parse(out))).toBe(out);
    expect(JSON.stringify(JSON.parse(out))).toBe(JSON.stringify(JSON.parse(text)));
  });

  it("gives different text for values that differ only under __proto__", () => {
    expect(canonicalJson(JSON.parse('{"__proto__":{"t":"x"},"x":1}'))).not.toBe(canonicalJson({ x: 1 }));
    expect(canonicalJson(JSON.parse('{"__proto__":{"t":"x"}}'))).not.toBe(canonicalJson(JSON.parse('{"__proto__":{"t":"y"}}')));
    expect(canonicalJson(JSON.parse('{"a":[{"__proto__":1}]}'))).not.toBe(canonicalJson(JSON.parse('{"a":[{"__proto__":2}]}')));
  });

  it("never touches Object.prototype", () => {
    canonicalJson(JSON.parse('{"__proto__":{"polluted":true}}'));
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
