import { existsSync } from "node:fs";
import { generateFixtures, parseFixtureSources, SNAPSHOT_KEYS } from "../scripts/build-fixtures.js";
import { primary } from "../src/fixtures/index.js";
import { expect, test } from "vitest";

test("committed fixture modules equal the hand-edited source projection", () => {
  const generated = generateFixtures(parseFixtureSources());
  expect(primary.base).toEqual(generated.base);
  expect(primary.overlay).toEqual(generated.overlay);
  expect(primary.merged).toEqual(generated.merged);
  for (const key of SNAPSHOT_KEYS) expect(primary.snapshots[key]).toEqual(generated.snapshots[key]);
});

test("every exported primary source path exists", () => {
  expect(existsSync(primary.paths.base)).toBe(true);
  expect(existsSync(primary.paths.overlay)).toBe(true);
  for (const path of Object.values(primary.paths.snapshots)) expect(existsSync(path)).toBe(true);
});
