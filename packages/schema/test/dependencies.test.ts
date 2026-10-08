import { expect, test } from "vitest";
import pkg from "../package.json";

// jmespath (a widget's `select`) is reachable only through the `@deck/schema/select` entry.
test("ajv and jmespath are the only runtime dependencies", () => {
  expect(Object.keys(pkg.dependencies).sort()).toEqual(["ajv", "jmespath"]);
});
