import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Schema composition and full config loads run several seconds on a loaded host, and
    // ~30% longer under Bun (the bun-parity CI job) than under Node; 15s still catches a hang.
    testTimeout: 15_000,
  },
});
