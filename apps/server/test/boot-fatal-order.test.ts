import { afterEach, describe, expect, it, vi } from "vitest";

import { stopScheduler } from "../src/providers/registry.js";
import { boot } from "../src/server/boot.js";
import { testModule } from "./util/modules.js";
import { makeConfigDir } from "./util/tmp-config.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  stopScheduler();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  while (cleanups.length) cleanups.pop()!();
});

/**
 * A binding that takes the docker module's fixed provider id: provider registration fails.
 * (Two estate ids that clash are a config error that validation reports first; a fixed id is
 * known only once the module offers it.)
 */
const duplicateProviderIds = {
  "00-base.yaml": {
    schemaVersion: 2,
    estate: { name: "fatal-order" },
    hosts: [{ name: "alpha", kind: "vm", purpose: "p" }, { name: "beta", kind: "vm", purpose: "p" }],
  },
  // Two bindings sharing an id: validation can only warn (PROVIDER_ID_SHARED, advisory at
  // boot), so the clash is found when both register.
  "10-overlay.yaml": {
    schemaVersion: 2,
    hosts: [
      { name: "alpha", bindings: { "http-health": { id: "probe", url: "https://a.invalid/" } } },
      { name: "beta", bindings: { "http-health": { id: "probe", url: "https://b.invalid/" } } },
    ],
  },
};

async function failedBoot(options: Parameters<typeof boot>[0]): Promise<string[]> {
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  vi.spyOn(process, "exit").mockImplementation(((code: number) => {
    throw new Error(`exit:${code}`);
  }) as never);
  await expect(boot({ port: 0, ...options })).rejects.toThrow("exit:2");
  return stderr.mock.calls.map(([text]) => String(text));
}

describe("boot: which of two fatal errors prints first", () => {
  it("a provider registration error precedes a broken actions runtime", async () => {
    const estate = makeConfigDir(duplicateProviderIds);
    cleanups.push(estate.cleanup);
    vi.stubEnv("DECK_ACTIONS_ENABLED", "true");
    vi.stubEnv("DECK_DATA_DIR", "");

    const printed = await failedBoot({ configDir: estate.dir });
    expect(printed).toEqual(["Provider id already registered: probe\n"]);
  });

  it("a provider registration error precedes any module init", async () => {
    const estate = makeConfigDir(duplicateProviderIds);
    cleanups.push(estate.cleanup);
    const init = vi.fn(() => {
      throw new Error("init should not run");
    });
    // The built-in data sources must stay, so the http-health providers still register.
    const { BUILTIN_MODULES } = await import("../src/modules/builtin.js");

    const printed = await failedBoot({ configDir: estate.dir, modules: [...BUILTIN_MODULES, testModule({ id: "late" }, init)] });
    expect(printed).toEqual(["Provider id already registered: probe\n"]);
    expect(init).not.toHaveBeenCalled();
  });
});
