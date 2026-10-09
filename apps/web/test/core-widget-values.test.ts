import { describe, expect, it } from "vitest";

import { formatValue, linkOf, readField, readItem } from "../src/features/core-widgets/values.js";

const NOW = Date.parse("2026-01-15T12:00:00Z");

describe("readField", () => {
  it("reads a key or a dotted path of own properties", () => {
    expect(readField({ a: 1 }, "a")).toBe(1);
    expect(readField({ load: { avg: 0.4 } }, "load.avg")).toBe(0.4);
    expect(readField({ load: null }, "load.avg")).toBeUndefined();
    expect(readField([1, 2], "0")).toBeUndefined();
    expect(readField({}, "toString")).toBeUndefined();
    expect(readField({ a: {} }, "a.constructor")).toBeUndefined();
  });
});

describe("readItem (B)", () => {
  it("reads an enumerated key as one key, and a configured field as a path", () => {
    const both = { "load.avg": 42, load: { avg: 99 } };
    expect(readItem(both, { field: "load.avg", direct: true })).toBe(42);
    expect(readItem(both, { field: "load.avg" })).toBe(99);
    expect(readItem({ "load.avg": 42 }, { field: "load.avg", direct: true })).toBe(42);
    expect(readItem({}, { field: "toString", direct: true })).toBeUndefined();
  });
});

describe("formatValue", () => {
  it("reads a time past a Date's range as given, never throwing (C)", () => {
    expect(formatValue(8.64e15, "relative-time", undefined, NOW)).toMatch(/ago$|just now/);
    expect(formatValue(-8.64e15, "relative-time", undefined, NOW)).toMatch(/ago$/);
    expect(formatValue(8.64e15 + 1, "relative-time", undefined, NOW)).toBe("8640000000000001");
    expect(formatValue(-8.64e15 - 1, "relative-time", undefined, NOW)).toBe("-8640000000000001");
    expect(formatValue(1e308, "relative-time", undefined, NOW)).toBe("1e+308");
    expect(formatValue("not a time", "relative-time", undefined, NOW)).toBe("not a time");
  });

  it("keeps a huge percent finite (E) and short (N3)", () => {
    for (const value of [1e308, -1e308, 1e9, -12_345_678_901]) {
      const text = formatValue(value, "percent", undefined, NOW);
      expect(text).not.toContain("∞");
      expect(text.length).toBeLessThanOrEqual(16);
    }
    expect(formatValue(1e308, "percent", undefined, NOW)).toBe("1E308%");
    expect(formatValue(999_999_999, "percent", undefined, NOW)).toBe("999,999,999%");
    expect(formatValue(1e308, "number", undefined, NOW).length).toBeLessThanOrEqual(16);
    // Tiny but not zero never reads as "0".
    expect(formatValue(0.0004, "number", undefined, NOW)).toBe("4E-4");
    expect(formatValue(0, "number", undefined, NOW)).toBe("0");
  });

  it.each([
    [1234567.891, "number", undefined, "1,234,567.89"],
    [512, "bytes", undefined, "512 B"],
    [1536, "bytes", undefined, "1.5 KiB"],
    [5 * 1024 ** 3, "bytes", undefined, "5.0 GiB"],
    [150 * 1024 ** 2, "bytes", undefined, "150 MiB"],
    [42.26, "percent", undefined, "42.3%"],
    ["87", "percent", "ignored", "87%"],
    [5_460, "duration", undefined, "1h 31m"],
    [3 * 86_400 + 4 * 3_600 + 5, "duration", undefined, "3d 4h"],
    [42, "duration", undefined, "42s"],
    [0, "duration", undefined, "0s"],
    ["2026-01-15T11:54:00Z", "relative-time", undefined, "6m ago"],
    [NOW - 3 * 3_600_000, "relative-time", undefined, "3h ago"],
    [61.5, "text", "W", "61.5 W"],
    [61.5, undefined, "W", "61.5 W"],
    ["on", "number", undefined, "on"],
    [true, undefined, undefined, "true"],
    [{ a: 1 }, undefined, undefined, '{"a":1}'],
    [null, undefined, undefined, ""],
  ] as const)("%j as %s (unit %s) reads %j", (value, format, unit, expected) => {
    expect(formatValue(value, format, unit, NOW)).toBe(expected);
  });
});

describe("linkOf", () => {
  it("allows http(s) URLs (external) and absolute paths in deck only", () => {
    expect(linkOf("https://vendor.example/x")).toEqual({ href: "https://vendor.example/x", external: true });
    expect(linkOf("/hosts/nas-01")).toEqual({ href: "/hosts/nas-01", external: false });
    expect(linkOf("javascript:alert(1)")).toBeUndefined();
    expect(linkOf("//evil.example")).toBeUndefined();
    expect(linkOf("relative/path")).toBeUndefined();
    expect(linkOf(42)).toBeUndefined();
  });

  it("refuses a path the browser would turn into another origin, and any whitespace or control", () => {
    expect(linkOf("/\t/evil.example")).toBeUndefined();
    expect(linkOf("/\n/evil.example")).toBeUndefined();
    expect(linkOf("/\r\n/evil.example")).toBeUndefined();
    expect(linkOf("https://ok.example/\tx")).toBeUndefined();
    expect(linkOf("/hosts\u0000")).toBeUndefined();
    expect(linkOf("/hosts name")).toBeUndefined();
    expect(linkOf("/hosts?q=a%20b#x")).toEqual({ href: "/hosts?q=a%20b#x", external: false });
  });
});
