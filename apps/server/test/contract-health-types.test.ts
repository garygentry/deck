import { describe, expectTypeOf, it } from "vitest";

import type { HealthResponse } from "../src/contract/index.js";
import type { LlmUsageHealth } from "../src/llm-usage/types.js";

describe("HealthResponse typing", () => {
  it("keeps the kernel fields strict and types each module's legacy field", () => {
    const health = {} as HealthResponse;
    expectTypeOf(health.uptimeMs).toEqualTypeOf<number>();
    expectTypeOf(health.llmUsage).toEqualTypeOf<LlmUsageHealth | undefined>();
    // @ts-expect-error a misspelt field is not part of the response
    void health.uptimeMS;
  });
});
