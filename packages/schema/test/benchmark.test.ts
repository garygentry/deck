import { performance } from "node:perf_hooks";
import { expect, test } from "vitest";
import { validate, validateSnapshot } from "../src/index.js";
import { benchmarkEstate } from "../src/fixtures/index.js";
import { deepFreeze } from "./util.js";

test("reference-scale fixture validates within the performance budget", () => {
  const estate = deepFreeze(benchmarkEstate());
  expect(estate.config.hosts?.length).toBeGreaterThanOrEqual(30);
  expect(estate.config.services?.length).toBeGreaterThanOrEqual(60);
  expect(estate.snapshot.hosts?.every((host) => host.facts && host.containers?.length && host.guests?.length)).toBe(true);
  expect(estate.snapshot.services?.every((service) => service.facts && Object.keys(service.facts).length > 0)).toBe(true);

  expect(validate(estate.config).classification).toBe(0);
  expect(validateSnapshot(estate.snapshot, estate.config).classification).toBe(0);
  const timings = Array.from({ length: 3 }, () => {
    const start = performance.now();
    validate(estate.config);
    validateSnapshot(estate.snapshot, estate.config);
    return performance.now() - start;
  });
  expect(Math.min(...timings)).toBeLessThan(200);
});
