import { describe, expect, test } from "vitest";
import { BUILTIN_CONTRIBUTIONS, composeConfig, composeDefault, FINDING_CODES, validate, validateSnapshot } from "../src/index.js";
import { FIXTURE_MODULE_STANDINS, invalid, kernelInvalid } from "../src/fixtures/index.js";
import type { InvalidFixture } from "../src/types.js";
import { deepFreeze } from "./util.js";

/** Whether a fixture carries a section a server module owns; deck's server tests validate those with the module. */
const moduleOwned = (entry: InvalidFixture): boolean =>
  [entry.document, entry.base].some((layer) => typeof layer?.modules === "object" && layer.modules !== null
    && FIXTURE_MODULE_STANDINS.some(({ id }) => Object.prototype.hasOwnProperty.call(layer.modules, id)));

describe("invalid fixture catalog", () => {
  test.each(invalid.filter((entry) => !moduleOwned(entry)))("$name produces $expect", (entry) => {
    const document = deepFreeze(entry.document);
    const result = entry.layer === "snapshot"
      ? validateSnapshot(document, entry.config === undefined ? undefined : deepFreeze(entry.config))
      : validate(document, {
        layer: entry.layer,
        ...(entry.base === undefined ? {} : { base: deepFreeze(entry.base) }),
        ...(entry.contributions === undefined ? {} : { composed: composeConfig([...BUILTIN_CONTRIBUTIONS, ...entry.contributions]) }),
        ...(entry.disabledSections === undefined ? {} : { disabledSections: entry.disabledSections }),
      });
    expect(result.classification).not.toBe(2);
    if (result.classification === 2) return;
    const finding = result.findings.find(({ code }) => code === entry.expect);
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe(composeDefault().catalog[entry.expect]!.severity);
  });

  test("protects every finding catalog entry", () => {
    const protectedCodes = new Set(invalid.map(({ expect }) => expect));
    expect(FINDING_CODES.filter((code) => !protectedCodes.has(code))).toEqual([]);
  });

  test("protects every code with a fixture this library validates itself", () => {
    const own = new Set([...invalid.filter((entry) => !moduleOwned(entry)), ...kernelInvalid].map(({ expect }) => expect));
    expect(FINDING_CODES.filter((code) => !own.has(code))).toEqual([]);
  });

  test.each(kernelInvalid)("$name produces $expect at $path", (entry) => {
    const result = validate(deepFreeze(entry.document), {
      layer: entry.layer as "base" | "overlay" | "merged",
      ...(entry.base === undefined ? {} : { base: deepFreeze(entry.base) }),
    });
    expect(result.classification).toBe(1);
    expect(result.findings).toContainEqual(expect.objectContaining({
      code: entry.expect,
      path: entry.path,
      severity: composeDefault().catalog[entry.expect]!.severity,
    }));
  });
});
