import { mkdir, open, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DeckConfigDocument, SnapshotDocument } from "@deck/schema";

/**
 * Ephemeral, feature-local mutable runtime for the Chromium inventory E2E suite.
 *
 * The Bun API helper is the sole owner: it prepares one invented config/snapshot
 * root before `boot()` and cleans it up on shutdown. Playwright workers only
 * attach (read the existing root) and mutate the snapshot through the publish
 * helpers below. Nothing here prints the runtime path, file contents, or any
 * secret sentinel — every rejection carries only a fixed operation label.
 */

/** Shared environment key set while the Playwright config loads. */
export const INVENTORY_E2E_RUNTIME_ENV = "DECK_INVENTORY_E2E_RUNTIME_DIR";

/** Config filename (JSON is valid YAML, and the loader reads only *.yaml/*.yml). */
const CONFIG_FILE = "estate.yaml";
/** Mutable snapshot filename consumed through DECK_SNAPSHOT_SOURCE. */
const SNAPSHOT_FILE = "snapshot.json";
/** Config subdirectory consumed through DECK_CONFIG_DIR. */
const CONFIG_DIR = "config";

/** Paths for one isolated invented Playwright runtime. */
export interface MutableInventoryRuntime {
  /** Deterministic absolute root shared by the API and Playwright processes. */
  readonly rootDir: string;
  /** Temporary config directory consumed through DECK_CONFIG_DIR. */
  readonly configDir: string;
  /** Mutable snapshot file consumed through DECK_SNAPSHOT_SOURCE. */
  readonly snapshotPath: string;
}

/** Owner handle created only by the API helper. */
export interface OwnedMutableInventoryRuntime extends MutableInventoryRuntime {
  /** Remove every temporary runtime file; safe to call repeatedly. */
  cleanup(): Promise<void>;
}

/** Wrap a filesystem failure so no path, content, or sentinel escapes. */
function runtimeError(operation: string): Error {
  return new Error(`Inventory runtime ${operation} failed.`);
}

function resolveRuntime(rootDir: string): MutableInventoryRuntime {
  const configDir = join(rootDir, CONFIG_DIR);
  return {
    rootDir,
    configDir,
    snapshotPath: join(rootDir, SNAPSHOT_FILE),
  };
}

/** Atomically replace a file via a same-directory temporary and rename. */
async function atomicWrite(
  targetPath: string,
  data: string | Uint8Array,
): Promise<void> {
  const tempPath = `${targetPath}.${process.pid}.${Date.now()}.${Math.random()
    .toString(36)
    .slice(2)}.tmp`;
  await writeFile(tempPath, data);
  await rename(tempPath, targetPath);
}

/** Recreate one explicit root and write the invented config plus initial snapshot. */
export async function prepareMutableInventoryRuntime(
  rootDir: string,
  config: DeckConfigDocument,
  snapshot: SnapshotDocument,
): Promise<OwnedMutableInventoryRuntime> {
  const runtime = resolveRuntime(rootDir);
  try {
    await rm(rootDir, { recursive: true, force: true });
    await mkdir(runtime.configDir, { recursive: true });
    await writeFile(join(runtime.configDir, CONFIG_FILE), JSON.stringify(config));
    await atomicWrite(runtime.snapshotPath, JSON.stringify(snapshot));
  } catch {
    throw runtimeError("preparation");
  }
  return {
    ...runtime,
    async cleanup() {
      try {
        await rm(rootDir, { recursive: true, force: true });
      } catch {
        throw runtimeError("cleanup");
      }
    },
  };
}

/** Attach to the already prepared root without rewriting or owning cleanup. */
export async function attachMutableInventoryRuntime(
  rootDir: string,
): Promise<MutableInventoryRuntime> {
  const runtime = resolveRuntime(rootDir);
  try {
    const [configStat, snapshotStat] = await Promise.all([
      stat(runtime.configDir),
      stat(runtime.snapshotPath),
    ]);
    if (!configStat.isDirectory() || !snapshotStat.isFile()) {
      throw runtimeError("attach");
    }
  } catch {
    throw runtimeError("attach");
  }
  return runtime;
}

/** Replace the snapshot atomically through a same-directory temporary file and rename. */
export async function publishSnapshot(
  runtime: MutableInventoryRuntime,
  snapshot: SnapshotDocument,
): Promise<void> {
  try {
    await atomicWrite(runtime.snapshotPath, JSON.stringify(snapshot));
  } catch {
    throw runtimeError("snapshot publication");
  }
}

/** Write stable malformed text for refused-read/last-good scenarios. */
export async function publishMalformedSnapshot(
  runtime: MutableInventoryRuntime,
  text = "{ malformed inventory snapshot",
): Promise<void> {
  try {
    await atomicWrite(runtime.snapshotPath, text);
  } catch {
    throw runtimeError("malformed publication");
  }
}

/** Write two chunks with a controlled pause to exercise overlap/torn-read behavior. */
export async function publishTornSnapshot(
  runtime: MutableInventoryRuntime,
  first: Uint8Array,
  second: Uint8Array,
  pauseMs: number,
): Promise<void> {
  if (!Number.isFinite(pauseMs) || pauseMs < 0) {
    throw new RangeError("pauseMs must be a finite, non-negative number.");
  }
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(runtime.snapshotPath, "w");
    await handle.write(first);
    await new Promise((resolve) => setTimeout(resolve, pauseMs));
    await handle.write(second);
  } catch {
    throw runtimeError("torn publication");
  } finally {
    await handle?.close();
  }
}
