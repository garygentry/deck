import { describe, expect, it } from "vitest";
import { canonicalize } from "../src/config/canonical.js";

describe("canonicalize", () => {
  it("sorts keys recursively, indents by two, preserves arrays, and adds one newline", () => {
    const output = canonicalize({ b: 1, a: { d: [3, 1, 2], c: true } } as never);
    expect(output).toBe('{\n  "a": {\n    "c": true,\n    "d": [\n      3,\n      1,\n      2\n    ]\n  },\n  "b": 1\n}\n');
    expect(output.endsWith("\n\n")).toBe(false);
  });
});
