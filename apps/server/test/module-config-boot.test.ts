import { afterEach, describe, expect, it, vi } from "vitest";

import { stopScheduler } from "../src/providers/registry.js";
import { makeConfigDir } from "./util/tmp-config.js";

// Two built-in modules that both declare the provider kind `twin-feed`.
vi.mock("../src/modules/builtin.js", async () => {
  const { testModule } = await import("./util/modules.js");
  return {
    BUILTIN_MODULES: [
      testModule({ id: "feed-one", providerKinds: [{ kind: "twin-feed" }] }),
      testModule({ id: "feed-two", providerKinds: [{ kind: "twin-feed" }] }),
    ],
  };
});

const { boot } = await import("../src/server/boot.js");
const { main } = await import("../src/cli/deck.js");

const cleanups: Array<() => void> = [];
afterEach(() => {
  stopScheduler();
  vi.restoreAllMocks();
  while (cleanups.length) cleanups.pop()!();
});

describe("a config contribution collision between two modules", () => {
  it("fails boot with exit 2 and MODULE_MANIFEST_CONFLICT before serving", async () => {
    const estate = makeConfigDir({ "00-base.yaml": { schemaVersion: 2, estate: { name: "collide" } } });
    cleanups.push(estate.cleanup);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.spyOn(process, "exit").mockImplementation(((code: number) => {
      throw new Error(`exit:${code}`);
    }) as never);

    await expect(boot({ configDir: estate.dir, port: 0 })).rejects.toThrow("exit:2");
    const printed = stderr.mock.calls.map(([text]) => String(text)).join("");
    expect(printed).toContain("MODULE_MANIFEST_CONFLICT");
    expect(printed).toContain('"twin-feed"');
  });

  it("makes deck validate exit 2 the same way", () => {
    const estate = makeConfigDir({ "00-base.yaml": { schemaVersion: 2, estate: { name: "collide" } } });
    cleanups.push(estate.cleanup);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(main(["validate", estate.dir])).toBe(2);
    expect(stderr.mock.calls.map(([text]) => String(text)).join("")).toContain("MODULE_MANIFEST_CONFLICT");
  });
});
