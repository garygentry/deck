import { describe, expect, it } from "vitest";
import { validate } from "../src/index.js";
import type { JsonObject } from "../src/types.js";

const doc = (host: JsonObject): JsonObject => ({
  schemaVersion: 2,
  estate: { name: "atlas" },
  hosts: [{ name: "alpha", kind: "vm", purpose: "lifecycle host", ...host }],
});

describe("Host.status lifecycle", () => {
  it("validates a host that omits status", () => {
    expect(validate(doc({})).classification).toBe(0);
  });

  for (const status of ["active", "planned", "retired"]) {
    it(`validates status '${status}', alone and alongside hidden`, () => {
      expect(validate(doc({ status })).classification).toBe(0);
      expect(validate(doc({ status, hidden: true })).classification).toBe(0);
    });
  }

  it("rejects a status outside the lifecycle enum", () => {
    const result = validate(doc({ status: "decommissioned" }));
    expect(result.classification).not.toBe(0);
    expect(result.findings.some((item) => item.severity === "error")).toBe(true);
  });
});
