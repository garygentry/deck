import { describe, expect, it } from "vitest";
import { validate } from "../src/index.js";
import { finding } from "../src/findings.js";
import { build, sortFindings } from "../src/validate/result.js";

describe("validate core", () => {
  it("classifies input and version gates before shape", () => {
    expect(validate(null)).toMatchObject({ classification: 2, toolError: { code: "INPUT_NOT_OBJECT" } });
    expect(validate({ schemaVersion: "1" })).toMatchObject({ classification: 2, toolError: { code: "VERSION_UNREADABLE" } });
    expect(validate({ schemaVersion: 3 })).toMatchObject({ classification: 1, findings: [{ code: "VERSION_UNSUPPORTED" }] });
    expect(validate({ schemaVersion: 2, estate: { name: "orion-lab" } })).toEqual({
      classification: 0,
      findings: [],
      summary: { error: 0, warning: 0, info: 0 },
    });
  });

  it("maps shape errors and supports relaxed overlays", () => {
    expect(validate({ schemaVersion: 2, estate: { name: "orion-lab", extra: true } })).toMatchObject({
      classification: 1,
      findings: [{ code: "SCHEMA_UNKNOWN_PROPERTY", path: "/estate/extra" }],
    });
    expect(validate({ schemaVersion: 2 }, { layer: "overlay" }).classification).toBe(0);
  });

  it("refuses a schemaVersion 1 document with a tool error naming deck config migrate", () => {
    for (const layer of ["base", "overlay", "merged"] as const) {
      const result = validate({ schemaVersion: 1, estate: { name: "orion-lab" } }, { layer });
      expect(result).toMatchObject({ classification: 2, findings: [], toolError: { code: "CONFIG_MIGRATION_REQUIRED" } });
      expect(result.classification === 2 && result.toolError.message).toContain("deck config migrate");
    }
  });

  it("sorts without mutating and classifies info-only findings as clean", () => {
    const source = [
      finding("SCHEMA_INVALID", "/z", "z"),
      finding("SECRET_VALUE_SUSPECTED", "/a", "a"),
    ];
    expect(sortFindings(source).map((item) => item.path)).toEqual(["/a", "/z"]);
    expect(source.map((item) => item.path)).toEqual(["/z", "/a"]);
    expect(build([finding("SECRET_VALUE_SUSPECTED", "/a", "a")])).toMatchObject({ classification: 0 });
  });
});
