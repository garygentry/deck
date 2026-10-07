import type { InvalidFixture } from "@deck/schema";

/**
 * Invalid fixtures for finding codes a built-in server module contributes (not the schema
 * library's catalog), each driven through `deck validate` like the library's fixtures.
 */
export const moduleInvalidFixtures: readonly InvalidFixture[] = [
  {
    name: "llm-usage-invalid",
    expect: "LLM_USAGE_INVALID",
    layer: "merged",
    document: { schemaVersion: 2, estate: { name: "invalid-fixture" }, modules: { "llm-usage": { thresholds: { warn: 95, danger: 90 } } } },
  },
];
