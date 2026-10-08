/**
 * `ui` hot reload, unit level: the reloader over an injected watch, loader and resolver, on
 * fake timers. The real directory watch and boot wiring are in `ui-reload.integration.test.ts`.
 */

import type { UiManifest } from "@deck/module-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LoaderResult } from "../src/config/load.js";
import type { DeckConfig } from "../src/contract/config.js";
import { createApp } from "../src/server/app.js";
import { createUiReloader, etagMatches, etagOf, type WatchDir } from "../src/ui/live.js";

const DEBOUNCE_MS = 100;

const base = (ui?: unknown, extra: Record<string, unknown> = {}): DeckConfig =>
  ({ schemaVersion: 2, estate: { name: "lab" }, ...extra, ...(ui === undefined ? {} : { ui }) }) as DeckConfig;

/** A stand-in manifest: the brand title is the config's `ui.brand.title`. */
const manifestOf = (config: DeckConfig): UiManifest =>
  ({
    uiApi: 1,
    brand: { title: (config as { ui?: { brand?: { title?: string } } }).ui?.brand?.title ?? "lab" },
    modules: [],
    slots: [],
    pages: [],
    navGroups: [],
    nav: [],
    extensions: [],
    providers: [],
    findings: [],
  }) as unknown as UiManifest;

const ok = (config: DeckConfig): LoaderResult => ({ exitClass: 0, config, findings: [], moduleProblems: new Map() });

function harness(boot = base({ brand: { title: "Lab" } })) {
  let onDisk: LoaderResult = ok(boot);
  let fire: () => void = () => undefined;
  const close = vi.fn();
  const watch: WatchDir = (_dir, onChange) => {
    fire = onChange;
    return { close };
  };
  const load = vi.fn(() => onDisk);
  const build = vi.fn(manifestOf);
  const logger = { info: vi.fn(), warn: vi.fn() };
  const reloader = createUiReloader({ configDir: "/cfg", config: boot, ui: manifestOf(boot), load, build, logger, watch, debounceMs: DEBOUNCE_MS });
  return {
    reloader,
    load,
    build,
    logger,
    close,
    write(result: LoaderResult | DeckConfig) {
      onDisk = "exitClass" in result ? result : ok(result);
    },
    fire: () => fire(),
    codes: () => reloader.current().ui.findings.map((finding) => finding.code),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("ui reloader", () => {
  it("swaps the config and manifest, with a new ETag, when only ui changed", async () => {
    const h = harness();
    const before = h.reloader.current();
    h.write(base({ brand: { title: "Gentry Lab" } }));

    await expect(h.reloader.reload()).resolves.toBe("applied");
    const after = h.reloader.current();
    expect(after.ui.brand.title).toBe("Gentry Lab");
    expect((after.config as { ui?: unknown }).ui).toEqual({ brand: { title: "Gentry Lab" } });
    expect(after.etag).not.toBe(before.etag);
    expect(after.etag).toBe(etagOf(after.ui));
    expect(h.logger.info).toHaveBeenCalledWith(expect.objectContaining({ event: "config.reload", result: "applied", configDir: "/cfg" }), expect.any(String));
  });

  it("keeps the same snapshot and ETag for an unchanged config", async () => {
    const h = harness();
    const before = h.reloader.current();

    await expect(h.reloader.reload()).resolves.toBe("unchanged");
    expect(h.reloader.current()).toBe(before);
    expect(h.build).not.toHaveBeenCalled();
  });

  it("debounces a burst of watch events into one reload", async () => {
    const h = harness();
    h.write(base({ brand: { title: "Next" } }));
    for (let i = 0; i < 5; i += 1) {
      h.fire();
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS - 10);
    }
    expect(h.load).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(h.load).toHaveBeenCalledOnce();
    expect(h.reloader.current().ui.brand.title).toBe("Next");
  });

  it("keeps the last good UI with a UI_CONFIG_INVALID finding when the config does not load, and clears it on revert", async () => {
    const h = harness();
    const good = h.reloader.current();
    h.write({ exitClass: 2, config: null, findings: [], toolError: { code: "CONFIG_YAML_PARSE", message: "Failed to parse /cfg/10-overlay.yaml: bad indentation" } });

    await expect(h.reloader.reload()).resolves.toBe("invalid");
    const kept = h.reloader.current();
    expect(kept.config).toBe(good.config);
    expect({ ...kept.ui, findings: [] }).toEqual(good.ui);
    expect(h.codes()).toEqual(["UI_CONFIG_INVALID"]);
    expect(kept.ui.findings[0]?.message).toContain("bad indentation");
    expect(kept.etag).not.toBe(good.etag);
    expect(h.logger.warn).toHaveBeenCalledWith(expect.objectContaining({ result: "invalid" }), expect.any(String));

    h.write(good.config);
    await expect(h.reloader.reload()).resolves.toBe("unchanged");
    expect(h.reloader.current().etag).toBe(good.etag);
    expect(h.codes()).toEqual([]);
  });

  it("names the first error findings of a config with findings", async () => {
    const h = harness();
    const error = (n: number) => ({ code: "SCHEMA_TYPE", severity: "error" as const, path: `/ui/brand/title${n}`, message: `must be string ${n}` });
    h.write({ exitClass: 1, config: null, findings: [1, 2, 3, 4].map(error) });

    await h.reloader.reload();
    const message = h.reloader.current().ui.findings[0]?.message ?? "";
    expect(message).toContain("SCHEMA_TYPE at /ui/brand/title1: must be string 1");
    expect(message).toContain("(and 1 more)");
  });

  it("treats a manifest that fails to resolve as invalid", async () => {
    const h = harness();
    h.build.mockImplementationOnce(() => {
      throw new Error("resolver exploded");
    });
    h.write(base({ brand: { title: "Next" } }));

    await expect(h.reloader.reload()).resolves.toBe("invalid");
    expect(h.reloader.current().ui.brand.title).toBe("Lab");
    expect(h.reloader.current().ui.findings[0]?.message).toContain("resolver exploded");
  });

  it("does not swap on a change outside ui, even with a ui change, and says a restart is required", async () => {
    const h = harness();
    h.write(base({ brand: { title: "Next" } }, { integrations: [{ id: "x", kind: "link" }] }));

    await expect(h.reloader.reload()).resolves.toBe("restart-required");
    expect(h.reloader.current().ui.brand.title).toBe("Lab");
    expect(h.codes()).toEqual(["UI_RESTART_REQUIRED"]);
    expect(h.reloader.current().ui.findings[0]?.message).toContain("integrations");
    expect(h.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: "config.reload", result: "restart-required", changedKeys: ["integrations"] }),
      "restart required",
    );
  });

  it("compares with the booted config, so reverting the outside change applies a pending ui edit", async () => {
    const h = harness();
    h.write(base({ brand: { title: "Next" } }, { estate: { name: "renamed" } }));
    await expect(h.reloader.reload()).resolves.toBe("restart-required");

    h.write(base({ brand: { title: "Next" } }));
    await expect(h.reloader.reload()).resolves.toBe("applied");
    expect(h.reloader.current().ui.brand.title).toBe("Next");
    expect(h.codes()).toEqual([]);
  });

  it("runs reloads one at a time, and once more for a change during one", async () => {
    const h = harness();
    let calls = 0;
    h.load.mockImplementation(() => {
      calls += 1;
      // A change arrives while the first reload runs.
      if (calls === 1) void h.reloader.reload();
      return ok(base({ brand: { title: `T${calls}` } }));
    });

    await h.reloader.reload();
    expect(h.load).toHaveBeenCalledTimes(2);
    expect(h.reloader.current().ui.brand.title).toBe("T2");
  });

  it("stops watching and drops a pending reload on stop", async () => {
    const h = harness();
    h.fire();
    h.reloader.stop();
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 2);

    expect(h.close).toHaveBeenCalledOnce();
    expect(h.load).not.toHaveBeenCalled();
  });
});

describe("served through the app", () => {
  it("reads the live snapshot per request: /api/ui with an ETag and 304, /api/config and the swap", async () => {
    vi.useRealTimers();
    const h = harness();
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => logger } as never;
    const app = createApp({
      config: base(),
      providers: { read: () => undefined, count: () => 0, listHealth: () => ({}), listProviders: () => [] },
      logger,
      live: h.reloader.current,
    });

    const first = await app.request("/api/ui");
    const etag = first.headers.get("ETag")!;
    expect(first.status).toBe(200);
    expect(first.headers.get("Cache-Control")).toBe("no-cache");
    expect(((await first.json()) as UiManifest).brand.title).toBe("Lab");
    expect((await app.request("/api/ui", { headers: { "If-None-Match": etag } })).status).toBe(304);

    h.write(base({ brand: { title: "Swapped" } }));
    await h.reloader.reload();
    const second = await app.request("/api/ui", { headers: { "If-None-Match": etag } });
    expect(second.status).toBe(200);
    expect(second.headers.get("ETag")).not.toBe(etag);
    expect(((await second.json()) as UiManifest).brand.title).toBe("Swapped");
    expect(((await (await app.request("/api/config")).json()) as { ui: unknown }).ui).toEqual({ brand: { title: "Swapped" } });
  });

  it("matches If-None-Match lists, weak tags and *", () => {
    expect(etagMatches(undefined, 'W/"a"')).toBe(false);
    expect(etagMatches('"b", W/"a"', 'W/"a"')).toBe(true);
    expect(etagMatches('"a"', 'W/"a"')).toBe(true);
    expect(etagMatches("*", 'W/"a"')).toBe(true);
    expect(etagMatches('W/"b"', 'W/"a"')).toBe(false);
  });
});
