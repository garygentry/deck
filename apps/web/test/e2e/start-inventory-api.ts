import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { boot, type BootHandle } from "../../../server/src/server/boot.js";
import { writeRunnersManifest } from "../../../server/test/fixtures/actions-runners/index.js";
import { materializeSourceFixture } from "../../../server/test/fixtures/materialize-source-fixture.js";
import {
  INVENTORY_E2E_RUNTIME_ENV,
  prepareMutableInventoryRuntime,
} from "./fixture-runtime.js";
import { buildInventoryScenario } from "./inventory-fixture.js";

/**
 * Real Bun API process for the Chromium inventory E2E suite.
 *
 * This helper is the SOLE owner of the mutable runtime: it prepares one invented
 * config/snapshot root before `boot()`, so port readiness proves preparation
 * completed, and it cleans that root up idempotently on SIGINT/SIGTERM and on a
 * failed start. It never prints the snapshot source path or fixture contents.
 */

const API_PORT = Number(process.env.DECK_E2E_API_PORT ?? 8788);

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  const rootDir = process.env[INVENTORY_E2E_RUNTIME_ENV];
  if (rootDir === undefined || rootDir.length === 0 || !isAbsolute(rootDir)) {
    fail("Inventory E2E runtime directory is missing or not absolute.");
  }

  // Invented, estate-fact-free declaration/reality pair covering every observable
  // inventory distinction. Generated at runtime with collection timestamps relative
  // to now so the server derives fresh/stale/partial deterministically; written
  // under the uncommitted ephemeral root — no fixture JSON is committed.
  const { config, overlay, snapshot } = buildInventoryScenario(Date.now());
  const runtime = await prepareMutableInventoryRuntime(rootDir, config, snapshot);
  // Presentation overlay (links/hidden) as a second layer the loader merges onto the
  // base; "overlay.yaml" sorts after the base "estate.yaml" so it applies last.
  await writeFile(join(runtime.configDir, "overlay.yaml"), JSON.stringify(overlay));

  // Enable the governed-actions write path for the actions e2e spec. `modules.actions`
  // is overlay-owned, so it is written as a third overlay layer whose name
  // sorts after "estate.yaml"/"overlay.yaml" (kept overlays, not the base). The
  // runner manifest and audit data dir live under the ephemeral root so the
  // owner's cleanup removes them with the rest of the runtime.
  await writeFile(
    join(runtime.configDir, "zz-actions.yaml"),
    JSON.stringify({
      schemaVersion: 2,
      modules: { actions: { actions: [
        {
          id: "e2e-echo",
          title: "E2E echo",
          runner: "echo-runner",
          confirm: "confirm",
          description: "Streams echo output to a distinct succeeded outcome.",
        },
        {
          id: "e2e-long",
          title: "E2E long runner",
          runner: "long-runner",
          confirm: "none",
          description: "Long-running action used to exercise cancel.",
        },
      ] } },
    }),
  );
  const actionsDataDir = join(rootDir, "actions-data");
  await mkdir(actionsDataDir, { recursive: true });
  const runnersFile = writeRunnersManifest(join(rootDir, "runners.json"));

  // Sources capability for the docs/configs e2e spec. Materialize the two committed local-path
  // fixtures (markdown-tree, file-tree) — the file-tree copy also gets the setup-only oversized
  // file + escape symlink — and declare them as a fourth overlay layer ("zzz-sources.yaml" sorts
  // last). No `owner` is set, so the owned-configs fragment on the inventory detail pages stays
  // empty (its e2e assertion is unaffected). Local-path sources acquire in place: no git, no
  // network. The copies live under the OS temp dir (NOT under `rootDir`) so their `location.path`
  // never embeds the runtime-root sentinel the inventory security scan forbids; their own cleanups
  // run on shutdown alongside the runtime owner's cleanup.
  const docsFixture = materializeSourceFixture("markdown-tree");
  const configsFixture = materializeSourceFixture("file-tree");
  await writeFile(
    join(runtime.configDir, "zzz-sources.yaml"),
    JSON.stringify({
      schemaVersion: 2,
      sources: [
        {
          id: "docs",
          kind: "markdown-tree",
          title: "Fixture Docs",
          location: { path: docsFixture.root },
        },
        {
          id: "configs",
          kind: "file-tree",
          title: "Fixture Configs",
          location: { path: configsFixture.root },
        },
      ],
    }),
  );
  process.env.DECK_SOURCES_CACHE_DIR = join(rootDir, "sources-cache");

  // A spec booting its own API may set a `ui` section (JSON in DECK_E2E_UI), written as the
  // last overlay layer: `ui` is overlay-owned.
  if (process.env.DECK_E2E_UI !== undefined) {
    await writeFile(join(runtime.configDir, "zzzz-ui.yaml"), JSON.stringify({ schemaVersion: 2, ui: JSON.parse(process.env.DECK_E2E_UI) }));
  }

  // Absolute inputs; boot reads DECK_SNAPSHOT_SOURCE once and never logs it.
  process.env.DECK_CONFIG_DIR = runtime.configDir;
  process.env.DECK_SNAPSHOT_SOURCE = runtime.snapshotPath;
  // resolveActionsRuntime(process.env) reads these once during boot(). Actions are on unless
  // DECK_E2E_ACTIONS_ENABLED is "false" (a spec booting its own actions-off API).
  process.env.DECK_ACTIONS_ENABLED = process.env.DECK_E2E_ACTIONS_ENABLED === "false" ? "false" : "true";
  process.env.DECK_RUNNERS_FILE = runnersFile;
  process.env.DECK_DATA_DIR = actionsDataDir;

  let handle: BootHandle | undefined;
  let cleaned = false;
  const cleanup = async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    // Remove the ephemeral runtime first so a slow/hung server stop cannot leave
    // the root behind; the server socket is torn down by process exit regardless.
    await runtime.cleanup();
    // The source fixture copies live outside the runtime root — remove them too.
    docsFixture.cleanup();
    configsFixture.cleanup();
    try {
      await handle?.stop();
    } catch {
      // Best-effort; exit forcibly terminates any remaining listener.
    }
  };

  const shutdown = (): void => {
    void cleanup().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  try {
    handle = await boot({ configDir: runtime.configDir, port: API_PORT });
  } catch {
    await cleanup();
    fail("Inventory E2E API failed to start.");
  }
}

void main();
