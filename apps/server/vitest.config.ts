import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Schema composition and full config loads run several seconds on a loaded host, and
    // ~30% longer under Bun (the bun-parity CI job) than under Node; 15s still catches a hang.
    testTimeout: 15_000,
    // Built-in modules' server tests run here, under the host that loads them (and so in the
    // node and Bun CI runs of this package).
    include: [...configDefaults.include, "../../modules/*/test/server/**/*.test.ts"],
  },
});
