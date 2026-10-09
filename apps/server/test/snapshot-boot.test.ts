import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { primary } from "@deck/schema/fixtures";
import type { DeckConfigDocument } from "@deck/schema";
import type { Logger } from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DeckConfig } from "../src/contract/index.js";
import { BootFatalError } from "@deck/module-sdk";
import { load } from "../src/config/load.js";
import { builtinKindHandlers } from "../src/modules/builtin.js";
import { registerAllProviders as registerWithKinds } from "../src/providers/index.js";
import { listEnvelopes, listHealth, listProviders, providerCount, read, setProjections, startScheduler, stopScheduler } from "../src/providers/registry.js";
import { SnapshotReadFailure } from "../src/providers/snapshot/errors.js";
import { SnapshotProvider } from "../src/providers/snapshot/index.js";
import { createSnapshotSource } from "../src/providers/snapshot/source.js";
import { createApp } from "../src/server/app.js";

/** A minimal config with no integrations, so only the snapshot provider polls. */
const minimalConfig = {
  schemaVersion: 2,
  estate: { name: "example-estate", freshness: { snapshotStaleAfter: "PT6H" } },
  hosts: [{ name: "host-a", kind: "vm", purpose: "Example workload" }],
} satisfies DeckConfigDocument;

/** Load the multi-provider portal fixture (docker + gatus) as the "previous set". */
function loadPortalConfig(): DeckConfig {
  const result = load({ arg: "test/fixtures/portal-estate" });
  if (result.exitClass !== 0) throw new Error("portal-estate fixture did not load");
  return result.config;
}

function makeApp(config: DeckConfig) {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
  return createApp({ config, providers: { read, count: providerCount, listHealth, listProviders, setProjections }, logger });
}

/** Register `config`'s providers with the built-in modules, the snapshot source set (or not). */
function registerAllProviders(config: DeckConfig, options: { snapshotSource?: string } = {}): void {
  const env = options.snapshotSource === undefined ? {} : { DECK_SNAPSHOT_SOURCE: options.snapshotSource };
  registerWithKinds(config, builtinKindHandlers(config, env));
}

const tmpDirs: string[] = [];

/** A path inside a fresh temp directory; created only if `seedValid` is true. */
function snapshotPath(seedValid: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), "deck-snapshot-boot-"));
  tmpDirs.push(dir);
  const path = join(dir, "snapshot.json");
  if (seedValid) copyFileSync(primary.paths.snapshots.combined, path);
  return path;
}

afterEach(() => {
  stopScheduler();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

describe("snapshot boot registration", () => {
  it("preserves the previous set and leaves an absent source at the PROVIDER_NOT_FOUND 404", async () => {
    const config = loadPortalConfig();
    registerAllProviders(config);

    // The estate providers still register; no snapshot slot is created.
    expect(providerCount()).toBeGreaterThan(0);
    expect(read("snapshot")).toBeUndefined();

    const app = makeApp(config);
    const response = await app.request("/api/providers/snapshot");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: "No provider registered with id 'snapshot'",
      code: "PROVIDER_NOT_FOUND",
    });
  });

  it("adds exactly one snapshot singleton in generated order when a source is present", async () => {
    const config = loadPortalConfig();
    registerAllProviders(config);
    const base = providerCount();
    stopScheduler();

    // The same multi-entity config plus one runtime source registers exactly one
    // extra slot; the source is never discovered per host/service (REQ-SNAPSHOT-09).
    registerAllProviders(config, { snapshotSource: snapshotPath(true) });
    expect(providerCount()).toBe(base + 1);
    expect(listEnvelopes().filter((envelope) => envelope.id === "snapshot")).toHaveLength(1);

    const app = makeApp(config);
    const response = await app.request("/api/providers/snapshot");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      id: "snapshot",
      kind: "snapshot",
      freshness: { state: "pending" },
      data: null,
    });
  });

  it("fails boot with a sanitized failure for an unsupported protocol without leaking the value", () => {
    const config = minimalConfig satisfies DeckConfig;
    const secret = "ftp://secret.example.internal/private-snapshot.json";

    let thrown: unknown;
    try {
      registerAllProviders(config, { snapshotSource: secret });
    } catch (error) {
      thrown = error;
    }

    // The snapshot module refuses it as boot-fatal (boot prints the message, exits 2).
    expect(thrown).toBeInstanceOf(BootFatalError);
    const failure = (thrown as BootFatalError).cause as SnapshotReadFailure;
    expect(failure).toBeInstanceOf(SnapshotReadFailure);
    expect(failure.code).toBe("SOURCE_PROTOCOL_UNSUPPORTED");
    expect((thrown as Error).message).toBe(failure.message);
    expect(failure.message).toContain("ftp");
    expect(failure.message).not.toContain("secret.example.internal");
    // A safe startup failure registers no snapshot slot.
    expect(read("snapshot")).toBeUndefined();
  });

  it("fails boot with SOURCE_UNREADABLE for an empty present source", () => {
    let thrown: unknown;
    try {
      registerAllProviders(minimalConfig, { snapshotSource: "   " });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(BootFatalError);
    expect(((thrown as BootFatalError).cause as SnapshotReadFailure).code).toBe("SOURCE_UNREADABLE");
  });

  it("registers a valid but unreadable source and polls it to failed-empty", async () => {
    const missing = snapshotPath(false);
    // Registration itself never touches the filesystem, so an unreadable source
    // does not abort boot; the failure surfaces only on the scheduled poll.
    expect(() => registerAllProviders(minimalConfig, { snapshotSource: missing })).not.toThrow();

    startScheduler();
    await vi.waitFor(() => {
      const envelope = read("snapshot");
      expect(envelope?.error).not.toBeNull();
      expect(envelope?.data).toBeNull();
    });

    // Failed-empty envelope carries a safe message that never leaks the path.
    const envelope = read("snapshot");
    expect(envelope?.error?.message ?? "").not.toContain(missing);
    expect(listHealth().snapshot).toMatchObject({ kind: "snapshot", ok: false });
  });
});

describe("snapshot source recovery", () => {
  it("recovers from an unreadable source to a clean read on a later poll", async () => {
    const path = snapshotPath(false);
    const source = createSnapshotSource(path);
    const provider = new SnapshotProvider("snapshot", { source, config: primary.merged });

    // First poll: no file yet — failed-empty, no retained data, unhealthy.
    await expect(provider.fetch()).rejects.toBeInstanceOf(SnapshotReadFailure);
    expect(provider.onFetchError(new SnapshotReadFailure("SOURCE_UNREADABLE", "x"), null)).toBeNull();
    expect((await provider.health()).ok).toBe(false);

    // The source becomes readable; the next poll accepts a complete snapshot.
    copyFileSync(primary.paths.snapshots.combined, path);
    const result = await provider.fetch();
    expect(result.snapshot).toBeTruthy();
    expect(result.readError).toBeNull();
    expect((await provider.health()).ok).toBe(true);
  });
});
