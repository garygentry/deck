import { describe, expect, test } from "vitest";
import { FINDING_CATALOG, FINDING_CODES, validate, validateSnapshot } from "../src/index.js";
import { invalid } from "../src/fixtures/index.js";
import { deepFreeze } from "./util.js";

describe("invalid fixture catalog", () => {
  test.each(invalid)("$name produces $expect", (entry) => {
    const document = deepFreeze(entry.document);
    const result = entry.layer === "snapshot"
      ? validateSnapshot(document, entry.config === undefined ? undefined : deepFreeze(entry.config))
      : validate(document, { layer: entry.layer, ...(entry.base === undefined ? {} : { base: deepFreeze(entry.base) }) });
    expect(result.classification).not.toBe(2);
    if (result.classification === 2) return;
    const finding = result.findings.find(({ code }) => code === entry.expect);
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe(FINDING_CATALOG[entry.expect].severity);
  });

  test("protects every finding catalog entry", () => {
    const protectedCodes = new Set(invalid.map(({ expect }) => expect));
    expect(FINDING_CODES.filter((code) => !protectedCodes.has(code))).toEqual([]);
  });
});
