import { expect, test } from "vitest";
import { validate, validateSnapshot } from "../src/index.js";
import { minimal, primary } from "../src/fixtures/index.js";
import { deepFreeze } from "./util.js";

function identifiers(value: unknown, key = ""): Set<string> {
  const found = new Set<string>();
  if (Array.isArray(value)) {
    for (const child of value) for (const token of identifiers(child, key)) found.add(token);
  } else if (value !== null && typeof value === "object") {
    for (const [childKey, child] of Object.entries(value)) {
      for (const token of identifiers(child, childKey)) found.add(token);
    }
  } else if (typeof value === "string" && ["name", "id", "host", "service"].includes(key)) {
    found.add(value.toLowerCase());
  }
  return found;
}

test("the independently invented minimal estate validates and has disjoint identifiers", () => {
  expect(validate(deepFreeze(minimal.config)).classification).toBe(0);
  expect(validateSnapshot(deepFreeze(minimal.snapshot), deepFreeze(minimal.config)).classification).toBe(0);
  const primaryTokens = identifiers({ config: primary.merged, snapshot: primary.snapshots.combined });
  const minimalTokens = identifiers(minimal);
  expect([...minimalTokens].filter((token) => primaryTokens.has(token))).toEqual([]);
});
