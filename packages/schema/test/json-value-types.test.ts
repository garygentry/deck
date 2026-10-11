import { describe, expect, it } from "vitest";

import type { DriftFinding, JsonValue } from "@deck/schema";

const jsonValues = [
  "text",
  42,
  true,
  null,
  ["nested", 1, false, null],
  { nested: ["value", 2] },
] satisfies readonly JsonValue[];

const driftFindings = jsonValues.map((value, index) => ({
  id: `fixture-drift-${index}`,
  severity: "info" as const,
  location: { host: "fixture-host" },
  category: "fixture",
  message: "Compile-time JSON value witness.",
  expected: value,
  observed: jsonValues[jsonValues.length - index - 1],
} satisfies DriftFinding));

describe("generated JSON-value fields", () => {
  it("accept every JSON value category in typed fixtures", () => {
    expect(driftFindings).toHaveLength(6);
  });
});
