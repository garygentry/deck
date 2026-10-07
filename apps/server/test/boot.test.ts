import { dirname } from "node:path";
import { invalid, primary } from "@deck/schema/fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";

import { load } from "../src/config/load.js";
import { boot, failFast } from "../src/index.js";
import { read, stopScheduler } from "../src/providers/registry.js";
import { makeConfigDir } from "./util/tmp-config.js";

const cleanup: Array<() => void> = [];

afterEach(() => {
  stopScheduler();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.DECK_SNAPSHOT_SOURCE;
  while (cleanup.length) cleanup.pop()!();
});

describe("server boot", () => {
  it("prints findings and exits with the loader exit class before serving", () => {
    const fixture = invalid.find(({ layer }) => layer === "base")!;
    const temporary = makeConfigDir({ "00-base.yaml": fixture.document });
    cleanup.push(temporary.cleanup);
    const result = load({ arg: temporary.dir });
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const exit = vi.fn((code: 1 | 2): never => {
      throw new Error(`exit:${code}`);
    });

    expect(() => failFast(result, exit)).toThrow(`exit:${result.exitClass}`);
    expect(exit).toHaveBeenCalledWith(result.exitClass);
    expect(stderr.mock.calls.map(([text]) => String(text)).join(""))
      .toContain(fixture.expect);
  });

  it("boots the clean primary directory and returns a stoppable handle", async () => {
    const stop = vi.fn(async () => undefined);
    const serve = vi.fn(() => ({ stop }));
    vi.stubGlobal("Bun", { serve });
    const handle = await boot({ configDir: dirname(primary.paths.base), port: 0 });

    expect(serve).toHaveBeenCalledOnce();
    expect(handle.port).toBe(0);
    await handle.stop();
    expect(stop).toHaveBeenCalledOnce();
  });

  it("registers no snapshot provider when DECK_SNAPSHOT_SOURCE is absent", async () => {
    delete process.env.DECK_SNAPSHOT_SOURCE;
    const stop = vi.fn(async () => undefined);
    vi.stubGlobal("Bun", { serve: vi.fn(() => ({ stop })) });
    const handle = await boot({ configDir: dirname(primary.paths.base), port: 0 });
    cleanup.push(() => void handle.stop());

    expect(read("snapshot")).toBeUndefined();
  });

  it("reads DECK_SNAPSHOT_SOURCE once and registers the snapshot provider without logging it", async () => {
    const source = primary.paths.snapshots.combined;
    process.env.DECK_SNAPSHOT_SOURCE = source;
    const writes: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });
    const stop = vi.fn(async () => undefined);
    vi.stubGlobal("Bun", { serve: vi.fn(() => ({ stop })) });

    const handle = await boot({ configDir: dirname(primary.paths.base), port: 0 });
    cleanup.push(() => void handle.stop());

    // The runtime source is carried into a single snapshot registration.
    expect(read("snapshot")).toBeDefined();
    // Neither config nor start logging echoes the source value.
    expect(writes.join("")).not.toContain(source);
  });
});
