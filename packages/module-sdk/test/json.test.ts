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
