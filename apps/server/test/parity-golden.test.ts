/**
 * Parity goldens: the semantic projection of deck (`deck validate` output, the API responses
 * and the route table) for the frozen v1 example estate and every estate fixture, compared
 * with the committed goldens in `test/golden/parity/`.
 *
 * These pin behaviour across refactors of how deck is wired. A diff here means observable
 * behaviour changed: fix the code, or, when the change is intended, refresh the goldens and
 * explain the diff in review:
 *
 *   DECK_UPDATE_GOLDENS=1 pnpm --filter @deck/server exec vitest run test/parity-golden.test.ts
 *
 * Without `DECK_UPDATE_GOLDENS=1` (always the case in CI) a missing or different golden fails.
 * See `test/parity/harness.ts` for how captures are made deterministic.
 */

import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { invalid, minimal, primary } from "@deck/schema/fixtures";
import type { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  capture,
  captureSnapshotValidate,
  createdApps,
  expectGolden,
  goldenPath,
  layersDir,
  normalise,
  readGolden,
  routeTable,
  SETTLE_TIMEOUT_MS,
  type ParityCase,
} from "./parity/harness.js";
import { withBuiltinModules } from "./parity/modules.js";
import { compareFindingLines, migratedCopy, remapV1Golden } from "./parity/v2.js";
import { PARITY_GATUS_AUTHORIZATION, setUpstreamOffline, upstreamFetch } from "./parity/upstream.js";
import { stopScheduler } from "../src/providers/registry.js";
import { moduleInvalidFixtures } from "./util/module-invalid-fixtures.js";

// A capture can wait SETTLE_TIMEOUT_MS for providers (twice with transitions); the test must
// outlive that, so the capture's own cleanup runs before the next case starts.
vi.setConfig({ testTimeout: SETTLE_TIMEOUT_MS * 3 });

vi.mock("../src/server/app.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/server/app.js")>();
  return {
    ...original,
    createApp: (deps: Parameters<typeof original.createApp>[0]): Hono => {
      const app = original.createApp(deps);
      createdApps.push(app);
      return app;
    },
  };
});

const primaryDir = dirname(primary.paths.base);

const ACTIONS_ENV = {
  DECK_ACTIONS_ENABLED: "true",
  DECK_DATA_DIR: "<tmp>/data",
  DECK_RUNNERS_FILE: "<server>/test/fixtures/actions-estate/runners.json",
};

/** Committed estate dirs, booted with the default env unless the case says otherwise. */
const DIR_CASES: ParityCase[] = [
  { id: "v1-estate", dir: "test/fixtures/v1-estate" },
  {
    // Every opt-in capability on, plus the snapshot source and static web routes: the widest
    // route table and provider set the v1 example can produce.
    id: "v1-estate.all-features",
    dir: "test/fixtures/v1-estate",
    web: true,
    env: {
      ...ACTIONS_ENV,
      DECK_SNAPSHOT_SOURCE: "<server>/test/fixtures/v1-estate/snapshot.json",
      DECK_METRICS_ENABLED: "true",
    },
  },
  { id: "v1-actions", dir: "test/fixtures/v1-actions", env: ACTIONS_ENV },
  {
    id: "v1-integrations",
    dir: "test/fixtures/v1-integrations",
    env: { DECK_PARITY_GATUS_TOKEN: PARITY_GATUS_AUTHORIZATION },
    transitions: true,
  },
  // The gatus credential env var unset: no Authorization header, so the routed gatus is a 401.
  { id: "v1-integrations.no-credential", dir: "test/fixtures/v1-integrations" },
  { id: "v1-llm-usage", dir: "test/fixtures/v1-llm-usage" },
  {
    id: "v1-llm-usage.ingest",
    dir: "test/fixtures/v1-llm-usage",
    env: { DECK_PARITY_INGEST_TOKEN: "parity-token" },
  },
  { id: "schema-primary", dir: primaryDir },
  {
    id: "schema-primary.snapshot",
    dir: primaryDir,
    env: { DECK_SNAPSHOT_SOURCE: primary.paths.snapshots.combined },
  },
  { id: "actions-smoke", dir: "test/fixtures/actions-smoke", env: ACTIONS_ENV },
  { id: "alerts-estate", dir: "test/fixtures/alerts-estate" },
  { id: "portal-estate", dir: "test/fixtures/portal-estate" },
  { id: "portal-broken-ref", dir: "test/fixtures/portal-broken-ref" },
];

/** In-memory fixtures, written to a temp estate dir per run. */
const DOCUMENT_CASES: Array<{ id: string; layers: () => Record<string, unknown> }> = [
  { id: "schema-minimal", layers: () => ({ "00-base.yaml": minimal.config }) },
];

/**
 * The base an overlay-layer invalid fixture sits on when it declares none: valid on its own,
 * and declaring the host the fixture factory uses, so the overlay reaches the rule it
 * targets instead of failing the merge.
 */
const DEFAULT_BASE = {
  schemaVersion: 2,
  estate: { name: "invalid-fixture" },
  hosts: [{ name: "echo", kind: "vm", purpose: "Invalid fixture host" }],
};

// A fixture that needs extra contributions composed (a kind no built-in module declares)
// cannot go through `deck validate`; provider-kinds.test.ts drives its code through a module.
const estateFixtures = [
  ...invalid.filter((fixture) => fixture.layer !== "snapshot" && fixture.contributions === undefined),
  ...moduleInvalidFixtures,
];
const snapshotFixtures = invalid.filter((fixture) => fixture.layer === "snapshot");

/** An invalid fixture as estate layers: an overlay on its base, anything else as the base. */
function invalidLayers(fixture: (typeof invalid)[number]): Record<string, unknown> {
  return fixture.layer === "overlay"
    ? { "00-base.yaml": fixture.base ?? DEFAULT_BASE, "10-overlay.yaml": fixture.document }
    : { "00-base.yaml": fixture.document };
}

const scratch: string[] = [];
afterEach(() => {
  while (scratch.length) rmSync(scratch.pop()!, { recursive: true, force: true });
  // A capture restores these itself; this is the backstop if one is ever cut short.
  stopScheduler();
  setUpstreamOffline(false);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function scratchFile(name: string, document: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "deck-parity-snap-"));
  scratch.push(dir);
  const file = join(dir, name);
  writeFileSync(file, JSON.stringify(document, null, 2));
  return file;
}

/**
 * Compare with a golden frozen from the v1 estate, under the declared v1 → v2 mapping
 * (`parity/v2.ts`) plus the built-in modules' declared additions (`parity/modules.ts`): the
 * same findings, paths remapped, and otherwise identical projections.
 */
function expectV2Parity(id: string, actual: unknown, extra: ReadonlyArray<[string, string]> = []): void {
  expectGolden(id, actual, { transformGolden: (golden) => withBuiltinModules(remapV1Golden(golden, extra)) });
}

/** The frozen v1 estates (`test/fixtures/v1-*`) boot from a migrated copy; they stay v1. */
const FROZEN_V1 = /(^|\/)v1-[^/]+$/;

describe("parity goldens", () => {
  for (const parityCase of DIR_CASES) {
    it(`${parityCase.id} matches its golden`, async () => {
      if (!FROZEN_V1.test(parityCase.dir)) {
        expectV2Parity(parityCase.id, await capture(parityCase));
        return;
      }
      const migrated = migratedCopy(parityCase.dir);
      try {
        expectV2Parity(parityCase.id, await capture({ ...parityCase, dir: migrated.dir }));
      } finally {
        migrated.cleanup();
      }
    });
  }

  for (const documentCase of DOCUMENT_CASES) {
    it(`${documentCase.id} matches its golden`, async () => {
      const estate = layersDir(documentCase.layers());
      try {
        expectV2Parity(documentCase.id, await capture({ id: documentCase.id, dir: estate.dir }));
      } finally {
        estate.cleanup();
      }
    });
  }

  it("the frozen v1 estates themselves are refused with the migrate hint", async () => {
    for (const parityCase of DIR_CASES.filter(({ dir }) => FROZEN_V1.test(dir))) {
      const { validate } = await capture(parityCase);
      expect(validate.exitClass, parityCase.id).toBe(2);
      expect(validate.stderr, parityCase.id).toMatch(/^CONFIG_MIGRATION_REQUIRED .*deck config migrate <estate>\n$/);
    }
  });

  it("every invalid estate fixture emits its code, and its deck validate output matches", async () => {
    // Fixtures added after the goldens froze (MODULE_UNKNOWN) are asserted on their code
    // only; the rest must match the frozen golden under the v1 → v2 mapping.
    const frozen = readGolden("invalid-fixtures") as Record<string, unknown>;
    const projections: Record<string, unknown> = {};
    for (const fixture of estateFixtures) {
      const estate = layersDir(invalidLayers(fixture));
      try {
        const { validate } = await capture({ id: fixture.name, dir: estate.dir });
        expect(`${validate.stdout}${validate.stderr}`, fixture.name).toContain(fixture.expect);
        if (fixture.name in frozen) projections[fixture.name] = validate;
      } finally {
        estate.cleanup();
      }
    }
    // The version fixture moved from 2 (unsupported under v1) to 3 (unsupported under v2).
    expectV2Parity("invalid-fixtures", projections, [
      ["schemaVersion 2 is not supported; this library supports version(s) 1.", "schemaVersion 3 is not supported; this library supports version(s) 2."],
    ]);
  });

  it("snapshot fixtures: deck snapshot validate, and the snapshot provider over a config", async () => {
    const projections: Record<string, unknown> = {};
    for (const [name, path] of Object.entries(primary.paths.snapshots)) {
      projections[`primary.${name}`] = { snapshotValidate: captureSnapshotValidate(path) };
    }
    for (const fixture of snapshotFixtures) {
      const file = scratchFile("snapshot.json", fixture.document);
      const entry: Record<string, unknown> = { snapshotValidate: captureSnapshotValidate(file) };
      // Cross-checks against the estate (undeclared hosts, unresolved drift locations) run
      // when the snapshot provider reads the file at boot, not in `deck snapshot validate`.
      if (fixture.config !== undefined) {
        const estate = layersDir({ "00-base.yaml": fixture.config });
        try {
          const booted = await capture({
            id: fixture.name,
            dir: estate.dir,
            env: { DECK_SNAPSHOT_SOURCE: file },
          });
          entry.envelope = normalise(booted.envelopes?.snapshot, [[file, "<snapshot>"]]);
        } finally {
          estate.cleanup();
        }
      }
      expect(JSON.stringify(entry), fixture.name).toContain(fixture.expect);
      projections[fixture.name] = entry;
    }
    expectV2Parity("snapshot-fixtures", projections);
  });
});

describe("the v1 -> v2 parity mapping", () => {
  it("migrates v1-llm-usage to this hand-written v2 config body (an oracle independent of expectedV2)", async () => {
    const migrated = migratedCopy("test/fixtures/v1-llm-usage");
    try {
      const { config } = await capture({ id: "v1-llm-usage", dir: migrated.dir });
      expect(config?.body).toEqual({
        schemaVersion: 2,
        estate: { name: "llm-usage-estate" },
        modules: {
          "llm-usage": {
            claude: {
              credentialsFile: "/nonexistent/claude/.credentials.json",
              statusLine: { credentialEnv: "DECK_PARITY_INGEST_TOKEN" },
              activeInterval: "PT2M",
              idleInterval: "PT5M",
            },
            thresholds: { warn: 70, danger: 85 },
            idlePause: "PT5M",
          },
        },
      });
    } finally {
      migrated.cleanup();
    }
  });

  it("remaps finding pointers only, leaving other strings exact", () => {
    const golden = {
      validate: { exitClass: 1, stdout: "", stderr: "error  /groups/0/items/0  REF_SERVICE_UNRESOLVED  service reference at /groups/0/items/0 does not resolve\n" },
      providers: { body: { baseUrl: "/groups", link: "https://lab.invalid/actions/1", note: "see /llmUsage" } },
    };
    expect(remapV1Golden(golden)).toEqual({
      validate: {
        exitClass: 1,
        stdout: "",
        stderr: "error  /modules/portal/groups/0/items/0  REF_SERVICE_UNRESOLVED  service reference at /modules/portal/groups/0/items/0 does not resolve\n",
      },
      providers: golden.providers,
    });
  });

  it("re-sorts each validated layer's block by its v2 paths, and nothing else", () => {
    const v1 = [
      "warning  /groups/0/id  LAYER_OVERLAY_KEY_IN_BASE  a",
      "error  /hosts/1  HOST_DUPLICATE  b",
      "error  /hosts/1  HOST_DUPLICATE  b",
      "warning  /groups/0/id  LAYER_OVERLAY_KEY_IN_BASE  a",
      "",
    ].join("\n");
    const remapped = remapV1Golden({ exitClass: 1, stdout: "", stderr: v1 }) as { stderr: string };
    // Two blocks (base, then merged), each sorted with /hosts before /modules.
    expect(remapped.stderr.split("\n")).toEqual([
      "error  /hosts/1  HOST_DUPLICATE  b",
      "warning  /modules/portal/groups/0/id  LAYER_OVERLAY_KEY_IN_BASE  a",
      "error  /hosts/1  HOST_DUPLICATE  b",
      "warning  /modules/portal/groups/0/id  LAYER_OVERLAY_KEY_IN_BASE  a",
      "",
    ]);
    expect(compareFindingLines("error  /a  X  m", "error  /b  X  m")).toBeLessThan(0);
  });

  it("fails a capture whose finding lines are reordered or duplicated", () => {
    const golden = readGolden("portal-broken-ref") as { validate: { stderr: string } };
    const expected = remapV1Golden(golden) as typeof golden;
    const lines = expected.validate.stderr.split("\n");
    const swapped = { ...expected, validate: { ...expected.validate, stderr: [lines[1], lines[0], ...lines.slice(2)].join("\n") } };
    const doubled = { ...expected, validate: { ...expected.validate, stderr: [lines[0], ...lines].join("\n") } };
    expect(lines.filter(Boolean).length).toBeGreaterThan(1);
    for (const wrong of [swapped, doubled]) {
      expect(() => expectGolden("portal-broken-ref", wrong, { update: false, transformGolden: (g) => remapV1Golden(g) })).toThrow();
    }
    expect(() => expectGolden("portal-broken-ref", expected, { update: false, transformGolden: (g) => remapV1Golden(g) })).not.toThrow();
  });
});

describe("parity golden harness", () => {
  it("fails on a projection that differs from the golden", () => {
    const golden = readGolden("v1-llm-usage") as { validate: object };
    expect(() => expectGolden("v1-llm-usage", { ...golden, validate: { exitClass: 1 } }, { update: false }))
      .toThrow();
  });

  it("fails on a missing golden instead of writing one", () => {
    expect(() => expectGolden("no-such-case", {}, { update: false })).toThrow(/DECK_UPDATE_GOLDENS=1/);
  });

  it("compares through transformGolden, the seam for a declared path remap", () => {
    const golden = readGolden("v1-llm-usage") as { config: { body: Record<string, unknown> } };
    const { llmUsage, ...rest } = golden.config.body;
    // A migrated estate moves a key; the frozen golden is remapped, not refreshed.
    const migrated = { ...golden, config: { ...golden.config, body: { ...rest, modules: { "llm-usage": llmUsage } } } };
    expectGolden("v1-llm-usage", migrated, {
      update: false,
      transformGolden: (frozen) => {
        const typed = frozen as typeof golden;
        const { llmUsage: moved, ...kept } = typed.config.body;
        return { ...typed, config: { ...typed.config, body: { ...kept, modules: { "llm-usage": moved } } } };
      },
    });
  });

  it("refuses to refresh a frozen golden through transformGolden in update mode", () => {
    const path = goldenPath("v1-llm-usage");
    const before = readFileSync(path, "utf8");
    const mtime = statSync(path).mtimeMs;
    vi.stubEnv("DECK_UPDATE_GOLDENS", "1");
    try {
      expect(() => expectGolden("v1-llm-usage", { migrated: true }, { transformGolden: (g) => g }))
        .toThrow(/refusing to refresh frozen golden/);
    } finally {
      vi.unstubAllEnvs();
    }
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(statSync(path).mtimeMs).toBe(mtime);
  });

  it("masks volatile values only at known paths, and only when they keep their shape", () => {
    const at = (latencyMs: unknown) => ({ envelopes: { web: { body: { data: { latencyMs } } } } });
    expect(normalise(at(3))).toEqual(at("<time:number>"));
    // A type change at a masked path stays visible.
    expect(normalise(at({ unexpected: true }))).toEqual(at({ unexpected: true }));
    expect(normalise(at("3ms"))).toEqual(at("3ms"));
    // The same key elsewhere is not masked.
    expect(normalise({ health: { body: { latencyMs: 3, uptimeMs: 0 } } }))
      .toEqual({ health: { body: { latencyMs: 3, uptimeMs: 0 } } });
    const audit = (runId: unknown) => ({ actionsAudit: { body: [{ runId }] } });
    expect(normalise(audit("c54772ef-130b-4477-8348-a919ef5f27d7"))).toEqual(audit("<uuid:string>"));
    expect(normalise(audit(42))).toEqual(audit(42));
  });

  it("counts a method + path registered more than once", () => {
    expect(routeTable([
      { method: "GET", path: "/api/health" },
      { method: "GET", path: "/api/health" },
      { method: "ALL", path: "*" },
    ])).toEqual(["ALL *", "GET /api/health ×2"]);
  });

  it("upstream router enforces the method and a route's credential", async () => {
    const statusOf = async (url: string, init?: RequestInit) => (await upstreamFetch(url, init)).status;
    expect(await statusOf("http://parity-upstream.invalid/api/health", { method: "HEAD" })).toBe(503);
    expect(await statusOf("http://parity-upstream.invalid/api/health", { method: "GET" })).toBe(405);
    const gatus = "http://parity-upstream.invalid/gatus/api/v1/endpoints/statuses";
    expect(await statusOf(gatus, { headers: { Authorization: PARITY_GATUS_AUTHORIZATION } })).toBe(200);
    expect(await statusOf(gatus)).toBe(401);
    expect(await statusOf(gatus, { headers: { Authorization: "Bearer wrong" } })).toBe(401);
    setUpstreamOffline(true);
    await expect(upstreamFetch(gatus, { headers: { Authorization: PARITY_GATUS_AUTHORIZATION } })).rejects.toThrow();
  });
});
