import { expect, test } from "vitest";
import { merge, validate, validateSnapshot } from "../src/index.js";
import { primary } from "../src/fixtures/index.js";
import type { JsonObject } from "../src/types.js";
import { deepFreeze } from "./util.js";

test("validation and merge are repeatable and independent across concurrent calls", async () => {
  const base = deepFreeze(structuredClone(primary.base));
  const overlay = deepFreeze(structuredClone(primary.overlay));
  const merged = deepFreeze(structuredClone(primary.merged));
  const snapshot = deepFreeze(structuredClone(primary.snapshots.combined));

  const invoke = () => ({
    config: validate(merged),
    snapshot: validateSnapshot(snapshot, merged),
    merged: merge(base as JsonObject, overlay as JsonObject),
  });

  const serial = invoke();
  expect(invoke()).toEqual(serial);
  expect(invoke()).toEqual(serial);

  const concurrent = await Promise.all([
    Promise.resolve().then(invoke),
    Promise.resolve().then(invoke),
    Promise.resolve().then(invoke),
  ]);
  expect(concurrent).toEqual([serial, serial, serial]);
});
