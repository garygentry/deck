import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import type { SnapshotProviderResult } from "@deck/contract";

import { hostHref, serviceHref } from "../../../modules/inventory/web/model.js";
import { INVENTORY_ENDPOINTS } from "../../../modules/inventory/web/use-inventory-data.js";
import { getPages } from "../src/registry/registry.js";
import { webTestRoots } from "./support/source-roots.js";

// Importing the feature entrypoint performs its four side-effecting page
// registrations into this file's isolated registry singleton.
import "../../../modules/inventory/web/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "../../..");
const featureDir = join(here, "../../../modules/inventory/web");

// ---------------------------------------------------------------------------
// Meta-guard scope (spec 08 §7.3).
//
// These guards protect the enumerated protection set: frozen registration,
// provider, route, and slot contracts; the absence of schema edits, estate
// facts, non-GET/secret/source APIs, unsafe HTML, feature-owned fragments, and
// drift/config-content rendering; a single installed Chromium project/worker;
// and no focused/skipped test gate.
//
// They deliberately do NOT prove provider correctness, rendered visual output,
// keyboard behavior, contrast, or any success-criterion behavior — those live in
// the behavioral Vitest and Chromium suites. Where a behavioral assertion exists
// we reference the runtime contract value rather than re-asserting implementation
// text (spec 08 §7.3 non-goals).
// ---------------------------------------------------------------------------

/** Recursively collect every `.ts`/`.tsx` source file under a directory. */
function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(full));
    else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) files.push(full);
  }
  return files;
}

const FEATURE_SOURCES = sourceFiles(featureDir);
const FEATURE_TEXT = FEATURE_SOURCES.map((file) => readFileSync(file, "utf8"));

// ---------------------------------------------------------------------------
// 1. Registration, provider, route, and slot contract freeze (protection set 3).
// ---------------------------------------------------------------------------

describe("frozen inventory registration and route contracts", () => {
  const INVENTORY_IDS = new Set(["page:inventory/hosts", "page:inventory/services", "page:inventory/host-detail", "page:inventory/service-detail"]);
  const inventoryPages = getPages().filter((page) => INVENTORY_IDS.has(page.id));

  it("registers exactly four inventory pages with the exact ids and paths", () => {
    const byId = new Map(inventoryPages.map((page) => [page.id, page]));
    expect(inventoryPages).toHaveLength(4);
    expect(byId.get("page:inventory/hosts")?.path).toBe("/hosts");
    expect(byId.get("page:inventory/services")?.path).toBe("/services");
    expect(byId.get("page:inventory/host-detail")?.path).toBe("/hosts/:name");
    expect(byId.get("page:inventory/service-detail")?.path).toBe("/services/:host/:name");
  });

  it("exposes exactly two primary-navigation entries (Hosts and Services)", () => {
    const navVisible = inventoryPages.filter((page) => page.nav !== false).map((page) => page.id);
    expect([...navVisible].sort()).toEqual(["page:inventory/hosts", "page:inventory/services"]);
    // The two dynamic detail routes are routable but hidden from primary nav.
    for (const id of ["page:inventory/host-detail", "page:inventory/service-detail"]) {
      expect(inventoryPages.find((page) => page.id === id)?.nav).toBe(false);
    }
  });

  it("freezes the browser-facing snapshot provider endpoint and id", () => {
    expect(INVENTORY_ENDPOINTS.snapshot).toBe("/api/providers/snapshot");
    expect(INVENTORY_ENDPOINTS.config).toBe("/api/config");
  });

  it("freezes independently-encoded detail route segments", () => {
    // Each path segment is encoded once so a `/` cannot forge an extra segment.
    expect(hostHref("a b/c")).toBe("/hosts/a%20b%2Fc");
    expect(serviceHref("h/1", "s#2")).toBe("/services/h%2F1/s%232");
  });
});

// A compile-time frozen-contract guard: the shared provider result must have
// exactly these five top-level keys. Renaming/adding/removing one fails
// `pnpm -r typecheck`, catching sibling-contract drift (spec 07 §9.3, CON-07).
const RESULT_KEYS = ["snapshot", "findings", "hostStates", "lastReadAt", "readError"] as const;
type ResultKey = keyof SnapshotProviderResult;
type ExpectedKey = (typeof RESULT_KEYS)[number];
type _ResultKeysAreExact = [ResultKey] extends [ExpectedKey]
  ? [ExpectedKey] extends [ResultKey]
    ? true
    : never
  : never;
const _resultKeysAreExact: _ResultKeysAreExact = true;
void _resultKeysAreExact;

describe("frozen snapshot provider result keys", () => {
  it("declares exactly the five compatibility-surface result keys", () => {
    expect([...RESULT_KEYS].sort()).toEqual(
      ["findings", "hostStates", "lastReadAt", "readError", "snapshot"].sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// 2. Feature source boundaries (protection set 4 and 5).
// ---------------------------------------------------------------------------

describe("feature source security and contract boundaries", () => {
  it("finds feature source files to scan", () => {
    expect(FEATURE_SOURCES.length).toBeGreaterThan(0);
  });

  it("never edits or deep-imports @deck/schema internals", () => {
    // The feature is read-only against packages/schema: it may consume the
    // public barrel wire types (via @deck/server) but must not reach into schema
    // source paths.
    for (const text of FEATURE_TEXT) {
      expect(text).not.toContain("packages/schema");
      expect(text).not.toMatch(/@deck\/schema\/src/);
    }
  });

  it("issues only GET requests (no non-GET fetch method)", () => {
    for (const text of FEATURE_TEXT) {
      for (const verb of ["POST", "PUT", "PATCH", "DELETE"]) {
        expect(text).not.toContain(`method: "${verb}"`);
        expect(text).not.toContain(`method: '${verb}'`);
      }
    }
  });

  it("exposes no secret resolver or source API surface", () => {
    // The not-configured hint may name the DECK_SNAPSHOT_SOURCE *setting*, but no
    // module may query a secret-resolver/source endpoint or resolve a value.
    for (const text of FEATURE_TEXT) {
      expect(text).not.toMatch(/\/api\/secrets?\b/);
      expect(text).not.toMatch(/\/api\/[a-z-]*source/i);
      expect(text).not.toContain("resolveSecret");
    }
  });

  it("never renders unsafe HTML", () => {
    for (const text of FEATURE_TEXT) {
      expect(text).not.toContain("dangerouslySetInnerHTML");
    }
  });

  it("registers no entity fragments of its own", () => {
    for (const text of FEATURE_TEXT) {
      expect(text).not.toContain("registerEntityFragment(");
    }
  });

  it("reads no snapshot.drift and renders no owned config-file contents", () => {
    // Drift UI and managed-config file contents belong to future siblings; this
    // feature renders only declared config path/source verdicts and placeholders.
    for (const [index, text] of FEATURE_TEXT.entries()) {
      // Strip block/line comments so the doc-comments that *name* the non-goal
      // ("snapshot.drift is never read") do not trip the lexical guard.
      const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
      expect(code, FEATURE_SOURCES[index]).not.toContain(".drift");
    }
  });
});

// ---------------------------------------------------------------------------
// 3. No estate facts in feature source or committed fixtures (protection set 4).
// ---------------------------------------------------------------------------

describe("estate-fact and invented-namespace guards", () => {
  // Maintained repository-level forbidden-estate sentinel list. Add any real
  // hostname/domain/address that must never reappear in committed inventory
  // source or fixtures; the guard fails if one is present.
  const FORBIDDEN_ESTATE_SENTINELS: readonly string[] = [];

  // Committed, invented feature-local fixtures (the ephemeral E2E runtime under
  // .tmp is uncommitted and excluded).
  const committedFixtures = [join(here, "e2e/inventory-fixture.ts")];
  const fixtureText = committedFixtures.map((file) => readFileSync(file, "utf8"));
  const scanned = [...FEATURE_TEXT, ...fixtureText];

  it("contains no forbidden-estate sentinel", () => {
    for (const sentinel of FORBIDDEN_ESTATE_SENTINELS) {
      for (const text of scanned) {
        expect(text).not.toContain(sentinel);
      }
    }
  });

  it("uses only RFC 6761 .invalid (or loopback) hosts in fixture URLs", () => {
    for (const text of fixtureText) {
      for (const match of text.matchAll(/https?:\/\/([^/"'\s]+)/g)) {
        const host = match[1].replace(/:\d+$/, "");
        const ok =
          host.endsWith(".invalid") || host === "localhost" || host === "127.0.0.1";
        expect(ok, `fixture URL host must be invented: ${match[0]}`).toBe(true);
      }
    }
  });

  it("uses no real top-level-domain hostnames in feature source or fixtures", () => {
    const realTld = /\b[a-z0-9-]+\.(?:com|net|org|io|dev|local|lan|home|co|app)\b/i;
    for (const text of scanned) {
      expect(text).not.toMatch(realTld);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Chromium configuration and installation are singular (protection set 7).
// ---------------------------------------------------------------------------

describe("Chromium configuration and CI installation", () => {
  const ciText = readFileSync(join(repoRoot, ".github/workflows/ci.yml"), "utf8");

  it("installs Playwright Chromium exactly once, before the e2e run", () => {
    // The e2e runs in a dedicated sharded `web-e2e` job; the browser is installed
    // once there, before the sharded `playwright test` invocation.
    const installs = ciText.match(/playwright install/g) ?? [];
    expect(installs).toHaveLength(1);
    const installIdx = ciText.indexOf("playwright install");
    const e2eIdx = ciText.indexOf("playwright test --shard");
    expect(installIdx).toBeGreaterThan(-1);
    expect(e2eIdx).toBeGreaterThan(installIdx);
    expect(ciText).toContain("pnpm --filter @deck/web exec playwright install --with-deps chromium");
  });

  it("runs the e2e suite once (sharded) and keeps the existing gates", () => {
    // A single sharded matrix invocation — the suite is not run twice.
    expect(ciText.match(/playwright test --shard/g) ?? []).toHaveLength(1);
    // Unit tests still run (in the node-pnpm job) and are not dropped.
    expect(ciText).toContain("test:unit");
    // Bun parity stays Vitest-only; no Playwright/Chromium install leaks into it.
    // Its wrapper starts vitest with `--bun`, so the tests run on Bun, not Node.
    expect(ciText).toContain("scripts/bun-parity-vitest.sh");
    const bunParityScript = readFileSync(join(repoRoot, "scripts/bun-parity-vitest.sh"), "utf8");
    expect(bunParityScript).toContain("bunx --bun vitest run");
    expect(bunParityScript).not.toMatch(/playwright/i);
    // Existing repository gates remain intact.
    expect(ciText).toContain("Check golden render");
    expect(ciText).toContain("Bare-Bun boot smoke");
  });
});

// ---------------------------------------------------------------------------
// 5. No focused or unconditionally skipped tests (protection set 7).
// ---------------------------------------------------------------------------

describe("no focused or skipped inventory tests", () => {
  const metaFile = fileURLToPath(import.meta.url);
  // The web suite's test roots: apps/web/test and every modules/<id>/test/web, so the module's
  // own tests are scanned as well as the kernel tests that drive it.
  const inventoryTestFiles = webTestRoots()
    .flatMap(sourceFiles)
    .filter((file) => /inventory/.test(relative(repoRoot, file)) && file !== metaFile);

  it("collects the inventory test files to scan", () => {
    expect(inventoryTestFiles.length).toBeGreaterThan(0);
    // The module's own tests live in modules/inventory/test/web, outside this directory.
    for (const moved of ["inventory-contrast.test.ts", "inventory-status.test.tsx"]) {
      expect(inventoryTestFiles).toContain(join(repoRoot, "modules/inventory/test/web", moved));
    }
  });

  it("contains no .only or unconditional .skip", () => {
    // Needles built by concatenation so this guard file cannot match itself even
    // if it were ever scanned.
    const forbidden = ["it" + ".only", "describe" + ".only", "test" + ".only", "." + "only("];
    const skips = ["it" + ".skip", "describe" + ".skip", "test" + ".skip", "." + "skip("];
    for (const file of inventoryTestFiles) {
      const text = readFileSync(file, "utf8");
      for (const needle of [...forbidden, ...skips]) {
        expect(text, file).not.toContain(needle);
      }
    }
  });
});
