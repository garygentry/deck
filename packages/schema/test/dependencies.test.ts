import { expect, test } from "vitest";
import pkg from "../package.json";

test("ajv is the only runtime dependency", () => {
  expect(Object.keys(pkg.dependencies)).toEqual(["ajv"]);
});
