import { describe, expect, it } from "vitest";

import { apiErrorBody } from "../src/index.js";

describe("apiErrorBody", () => {
  it("serialises as the kernel's {error, code} envelope, omitting an absent code", () => {
    expect(JSON.stringify(apiErrorBody("Unauthorized", "UNAUTHORIZED"))).toBe('{"error":"Unauthorized","code":"UNAUTHORIZED"}');
    expect(JSON.stringify(apiErrorBody("Not found"))).toBe('{"error":"Not found"}');
  });
});
