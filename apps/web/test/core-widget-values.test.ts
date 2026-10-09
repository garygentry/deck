import { describe, expect, it } from "vitest";

import { formatValue, linkOf, readField } from "../src/features/core-widgets/values.js";

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

describe("formatValue", () => {
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
});
