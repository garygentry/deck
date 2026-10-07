import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  emitDriftDiagnostic,
  setDriftDiagnosticSink,
  type DriftDiagnosticEvent,
} from "../src/features/drift-and-coverage/diagnostics.js";

// ---------------------------------------------------------------------------
// Drift meta-guards (spec 08 §10.2 — the closed, enumerated protection set).
//
// These lexical/filesystem/runtime guards protect ONLY the eleven items below.
// They deliberately do NOT prove — and must not be read as proving — WCAG
// conformance, visual layout, keyboard behavior, semantic rendering,
// grouping/counting/filtering correctness, atomicity, performance, upstream
// secret absence, dependency-tree purity, or general security (spec 08 §10.3).
// Those live in the behavioral Vitest and Chromium suites and in typecheck/
// build/dependency review. A new lexical shape outside this set is not by
// itself a defect in this guard.
//
// Every lexical guard first asserts its intended file/needle universe is
// non-empty so an empty scan can never vacuously pass, and needles are built by
// concatenation where required so this guard file cannot match itself.
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const webFeatureDir = resolve(here, "../src/features/drift-and-coverage");
const serverDriftDir = resolve(repoRoot, "apps/server/src/drift");

/** Recursively collect every `.ts`/`.tsx` source file under a directory. */
function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(full));
    else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))
      files.push(full);
  }
  return files;
}

/** Strip block and line comments so doc-comments that NAME a non-goal cannot
 * trip a lexical guard for the thing they promise the code avoids. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

const WEB_FEATURE_FILES = sourceFiles(webFeatureDir);
const WEB_FEATURE_TEXT = WEB_FEATURE_FILES.map((file) => readFileSync(file, "utf8"));
const WEB_FEATURE_CODE = WEB_FEATURE_TEXT.map(stripComments);

const SERVER_DRIFT_FILES = sourceFiles(serverDriftDir);
const SERVER_DRIFT_TEXT = SERVER_DRIFT_FILES.map((file) => readFileSync(file, "utf8"));

/** All feature source (web + server drift), used by the read-only/estate guards. */
const ALL_FEATURE_FILES = [...WEB_FEATURE_FILES, ...SERVER_DRIFT_FILES];
const ALL_FEATURE_CODE = [...WEB_FEATURE_CODE, ...SERVER_DRIFT_TEXT.map(stripComments)];

describe("drift meta-guard source universe", () => {
  it("found web feature and server drift source files to scan", () => {
    expect(WEB_FEATURE_FILES.length).toBeGreaterThan(0);
    expect(SERVER_DRIFT_FILES.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 1. No write methods anywhere in the drift feature (read-only surface).
// ---------------------------------------------------------------------------

describe("1. no non-GET request methods", () => {
  it("scans a non-empty feature universe", () => {
    expect(ALL_FEATURE_CODE.length).toBeGreaterThan(0);
  });

  it("contains no method: POST/PUT/PATCH/DELETE literal", () => {
    for (const verb of ["POST", "PUT", "PATCH", "DELETE"]) {
      for (const [index, code] of ALL_FEATURE_CODE.entries()) {
        expect(code, ALL_FEATURE_FILES[index]).not.toContain(`method: "${verb}"`);
        expect(code, ALL_FEATURE_FILES[index]).not.toContain(`method: '${verb}'`);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 2. No browser persistence or analytics.
// ---------------------------------------------------------------------------

describe("2. no browser persistence or analytics", () => {
  // Comments stripped so a doc-comment noting "never persisted" does not trip
  // a persistence needle.
  const PERSISTENCE_NEEDLES = [
    "localStorage",
    "sessionStorage",
    "indexedDB",
    "caches.open",
    "document.cookie",
  ];
  // The repository ships no analytics client; these are the shapes a future one
  // would take. Kept specific so ordinary identifiers (e.g. a `segment`
  // variable) are not mistaken for an analytics call.
  const ANALYTICS_NEEDLES = ["dataLayer", "gtag(", "mixpanel", "posthog"];

  it("scans a non-empty feature universe", () => {
    expect(WEB_FEATURE_CODE.length).toBeGreaterThan(0);
  });

  it("uses no web-storage, cookie, cache-storage, or analytics surface", () => {
    for (const needle of [...PERSISTENCE_NEEDLES, ...ANALYTICS_NEEDLES]) {
      for (const [index, code] of WEB_FEATURE_CODE.entries()) {
        expect(code, WEB_FEATURE_FILES[index]).not.toContain(needle);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 3. No raw-HTML / evaluator path in evidence/finding/fragment renderers.
// ---------------------------------------------------------------------------

describe("3. no raw-HTML or HTML-evaluator path in value renderers", () => {
  const RENDERER_NAMES = [
    "components/EvidenceValue.tsx",
    "components/FindingRow.tsx",
    "FindingsFragment.tsx",
  ];
  const RENDERER_FILES = RENDERER_NAMES.map((name) => join(webFeatureDir, name));
  const RENDERER_TEXT = RENDERER_FILES.map((file) => readFileSync(file, "utf8"));
  const RAW_HTML_NEEDLES = [
    "dangerouslySetInnerHTML",
    ".innerHTML",
    "insertAdjacentHTML",
    "DOMParser",
  ];

  it("found the three value-renderer files", () => {
    expect(RENDERER_TEXT).toHaveLength(3);
    for (const text of RENDERER_TEXT) expect(text.length).toBeGreaterThan(0);
  });

  it("contains no raw-HTML sink or HTML parser", () => {
    for (const needle of RAW_HTML_NEEDLES) {
      for (const [index, text] of RENDERER_TEXT.entries()) {
        expect(text, RENDERER_FILES[index]).not.toContain(needle);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Diagnostics carry only the exact DERIVE_KEYS / RENDER_KEYS (spec 08 §5.6).
//    Runtime recorder assertions elsewhere remain the authority for VALUES; this
//    proves the emitted KEY sets are exactly those and nothing else.
// ---------------------------------------------------------------------------

describe("4. drift diagnostics expose only the allowlisted key sets", () => {
  const DERIVE_KEYS = [
    "durationMs",
    "event",
    "findingsCount",
    "hostCount",
    "outcome",
    "refreshGeneration",
    "snapshotGeneratedAt",
  ] as const;
  const RENDER_KEYS = [
    "durationMs",
    "event",
    "findingsCount",
    "hostCount",
    "outcome",
    "refreshGeneration",
    "surface",
  ] as const;

  /** Capture the single event `emit(...)` publishes through a recorder sink. */
  function capture(event: DriftDiagnosticEvent): Record<string, unknown> {
    const seen: Record<string, unknown>[] = [];
    const restore = setDriftDiagnosticSink((published) => {
      seen.push(published as unknown as Record<string, unknown>);
    });
    try {
      emitDriftDiagnostic(event);
    } finally {
      restore();
    }
    expect(seen).toHaveLength(1);
    return seen[0]!;
  }

  it("emits exactly DERIVE_KEYS for a drift.derive event", () => {
    const published = capture({
      event: "drift.derive",
      outcome: "ok",
      refreshGeneration: 3,
      snapshotGeneratedAt: "2035-01-15T12:00:00.000Z",
      findingsCount: 7,
      hostCount: 5,
      durationMs: 1.5,
    });
    expect(Object.keys(published).sort()).toEqual([...DERIVE_KEYS].sort());
  });

  it("emits exactly RENDER_KEYS for a drift.render event", () => {
    const published = capture({
      event: "drift.render",
      surface: "page",
      outcome: "ok",
      refreshGeneration: 3,
      findingsCount: 7,
      hostCount: 5,
      durationMs: 1.5,
    });
    expect(Object.keys(published).sort()).toEqual([...RENDER_KEYS].sort());
  });

  it("strips any extra caller-supplied key rather than passing it through", () => {
    // A caller that smuggles an extra field (cast past the closed union) must
    // not have it survive the canonical rebuild.
    const smuggled = {
      event: "drift.render",
      surface: "page",
      outcome: "ok",
      refreshGeneration: 3,
      findingsCount: 7,
      hostCount: 5,
      durationMs: 1.5,
      leakedHost: "fixture-host-a.invalid",
    } as unknown as DriftDiagnosticEvent;
    const published = capture(smuggled);
    expect(Object.keys(published).sort()).toEqual([...RENDER_KEYS].sort());
    expect(published).not.toHaveProperty("leakedHost");
  });
});

// ---------------------------------------------------------------------------
// 5. Browser-safe server drift imports (lexical). The build/import test in
//    `drift-contract.test.ts` remains the authority for the actual graph.
// ---------------------------------------------------------------------------

describe("5. server drift source imports no server-only runtime", () => {
  // Documented server-only specifiers a browser bundle must never load.
  const FORBIDDEN_MODULE =
    /^(?:node:|bun(?::|$)|hono(?:\/|$)|pino(?:\/|$)|(?:fs|path|os|crypto|http|https|http2|net|dns|tls|url|stream|zlib|events|child_process|worker_threads|process|module|vm|readline|dgram|cluster|inspector)$)/;

  /** Every import/export-from specifier (type or value) in a module. */
  function importSpecifiers(source: string): string[] {
    const specs: string[] = [];
    const fromStatement =
      /^[ \t]*(?:import|export)\b[\s\S]*?\bfrom[ \t]*["']([^"']+)["']/gm;
    for (
      let match = fromStatement.exec(source);
      match;
      match = fromStatement.exec(source)
    ) {
      specs.push(match[1]!);
    }
    const sideEffect = /^[ \t]*import[ \t]*["']([^"']+)["'][ \t]*;?[ \t]*$/gm;
    for (
      let match = sideEffect.exec(source);
      match;
      match = sideEffect.exec(source)
    ) {
      specs.push(match[1]!);
    }
    return specs;
  }

  it("scans a non-empty server drift universe with real imports", () => {
    expect(SERVER_DRIFT_FILES.length).toBeGreaterThan(0);
    const total = SERVER_DRIFT_TEXT.reduce(
      (sum, text) => sum + importSpecifiers(text).length,
      0,
    );
    expect(total).toBeGreaterThan(0);
  });

  it("names no Node built-in, Bun, Hono, Pino, filesystem, or network module", () => {
    for (const [index, text] of SERVER_DRIFT_TEXT.entries()) {
      for (const specifier of importSpecifiers(text)) {
        expect(specifier, SERVER_DRIFT_FILES[index]).not.toMatch(FORBIDDEN_MODULE);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 6. No drift/secret/auth endpoint, schema-deep import, or alerts-and-health dep.
// ---------------------------------------------------------------------------

describe("6. no forbidden endpoint, schema-deep import, or sibling dependency", () => {
  it("scans a non-empty feature universe", () => {
    expect(ALL_FEATURE_CODE.length).toBeGreaterThan(0);
  });

  it("declares no /api/drift, secret, or auth endpoint", () => {
    for (const [index, code] of ALL_FEATURE_CODE.entries()) {
      const file = ALL_FEATURE_FILES[index];
      expect(code, file).not.toMatch(/\/api\/drift\b/);
      expect(code, file).not.toMatch(/\/api\/secrets?\b/);
      expect(code, file).not.toMatch(/\/api\/auth\b/);
      expect(code, file).not.toContain("resolveSecret");
    }
  });

  it("deep-imports no @deck/schema internals", () => {
    for (const [index, code] of ALL_FEATURE_CODE.entries()) {
      const file = ALL_FEATURE_FILES[index];
      expect(code, file).not.toContain("packages/schema");
      expect(code, file).not.toMatch(/@deck\/schema\/src/);
    }
  });

  it("imports nothing from alerts-and-health", () => {
    // Match an actual import specifier, not the phrase in a doc-comment.
    for (const [index, code] of ALL_FEATURE_CODE.entries()) {
      expect(code, ALL_FEATURE_FILES[index]).not.toMatch(
        /from\s+["'][^"']*alerts-and-health/,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// 7. Exact behavioral registration is delegated to the registry test.
//    Spec 08 §10.2(7): checked behaviorally through registry accessors, NOT by
//    scanning registration source text here.
// ---------------------------------------------------------------------------

describe("7. registration behavior is delegated to registry accessors", () => {
  const registrationTest = join(here, "drift-registration.test.ts");
  const registrationText = readFileSync(registrationTest, "utf8");

  it("has a non-empty registration behavioral suite that inspects registry accessors", () => {
    expect(registrationText.length).toBeGreaterThan(0);
    // The authority for the exact four ids/paths/slots is behavioral: it imports
    // the feature entry and reads registry accessors rather than scanning source.
    expect(registrationText).toContain("../src/features/drift-and-coverage/index.js");
    expect(registrationText).toMatch(/getPages|getEntityFragments|getExtensions/);
  });
});

// ---------------------------------------------------------------------------
// 8. No focused or unconditionally skipped drift tests.
// ---------------------------------------------------------------------------

describe("8. no focused or skipped drift tests", () => {
  const metaFile = fileURLToPath(import.meta.url);
  const webDriftTests = sourceFiles(here).filter(
    (file) => /drift-/.test(file) && file !== metaFile,
  );
  const serverTestDir = resolve(repoRoot, "apps/server/test");
  const serverDriftTests = sourceFiles(serverTestDir).filter((file) =>
    /drift-/.test(file),
  );
  const driftTestFiles = [...webDriftTests, ...serverDriftTests];

  it("collects the drift test files to scan", () => {
    expect(driftTestFiles.length).toBeGreaterThan(0);
  });

  it("contains no .only or unconditional .skip", () => {
    // Needles built by concatenation so this guard cannot match itself.
    const forbidden = [
      "it" + ".only",
      "describe" + ".only",
      "test" + ".only",
      "." + "only(",
    ];
    const skips = ["it" + ".skip", "describe" + ".skip", "test" + ".skip", "." + "skip("];
    for (const file of driftTestFiles) {
      const text = readFileSync(file, "utf8");
      for (const needle of [...forbidden, ...skips]) {
        expect(text, file).not.toContain(needle);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 9. Unchanged single-Chromium configuration (read-only; this guard does not
//    authorize editing the Playwright config or CI workflow).
// ---------------------------------------------------------------------------

describe("9. single Chromium project/worker and CI install order", () => {
  const playwrightConfig = readFileSync(
    resolve(here, "../playwright.config.ts"),
    "utf8",
  );
  const ciText = readFileSync(join(repoRoot, ".github/workflows/ci.yml"), "utf8");

  it("keeps exactly one Chromium project running with a single worker", () => {
    expect(playwrightConfig).toContain("workers: 1");
    expect(playwrightConfig).toContain("fullyParallel: false");
    const projectNames = [...playwrightConfig.matchAll(/name:\s*"([^"]+)"/g)].map(
      (match) => match[1],
    );
    expect(projectNames).toEqual(["chromium"]);
  });

  it("installs Playwright Chromium exactly once, before the e2e run", () => {
    // The e2e was split into a dedicated sharded `web-e2e` job; the browser is
    // installed once there, before the sharded `playwright test` invocation.
    expect(ciText.match(/playwright install/g) ?? []).toHaveLength(1);
    const installIdx = ciText.indexOf("playwright install");
    const e2eIdx = ciText.indexOf("playwright test --shard");
    expect(installIdx).toBeGreaterThan(-1);
    expect(e2eIdx).toBeGreaterThan(installIdx);
    expect(ciText).toContain(
      "pnpm --filter @deck/web exec playwright install --with-deps chromium",
    );
  });
});

// ---------------------------------------------------------------------------
// 10. Invented sentinel/host policy.
// ---------------------------------------------------------------------------

describe("10. invented estate sentinels and hostnames only", () => {
  // Maintained repository-level forbidden-estate sentinel list. Add any real
  // hostname/domain/address that must never reappear in committed drift source
  // or fixtures; the guard fails if one is present.
  const FORBIDDEN_ESTATE_SENTINELS: readonly string[] = [];

  // Committed, invented drift fixtures/tests carrying fixture identities and
  // URLs (the ephemeral .tmp E2E runtime is uncommitted and excluded).
  const committedFixtures = [
    join(here, "drift-store.test.ts"),
    join(here, "drift-keyboard.test.tsx"),
    join(here, "e2e/drift.spec.ts"),
  ];
  const fixtureText = committedFixtures.map((file) => readFileSync(file, "utf8"));
  const scannedForSentinels = [...WEB_FEATURE_TEXT, ...SERVER_DRIFT_TEXT, ...fixtureText];

  it("found the committed fixtures to scan", () => {
    for (const text of fixtureText) expect(text.length).toBeGreaterThan(0);
  });

  it("contains no forbidden-estate sentinel", () => {
    for (const sentinel of FORBIDDEN_ESTATE_SENTINELS) {
      for (const text of scannedForSentinels) {
        expect(text).not.toContain(sentinel);
      }
    }
    // The list is intentionally empty today; assert it exists as a maintained
    // array so a future real sentinel has a defined home.
    expect(Array.isArray(FORBIDDEN_ESTATE_SENTINELS)).toBe(true);
  });

  it("uses only RFC 6761 .invalid (or loopback) hosts in committed fixture URLs", () => {
    for (const [index, text] of fixtureText.entries()) {
      for (const match of text.matchAll(/https?:\/\/([^/"'\s]+)/g)) {
        // Strip a literal port or a template-interpolated one
        // (`http://127.0.0.1:${process.env.PORT ?? 8788}`); the host check is unchanged.
        const host = match[1].replace(/:(\d+|\$\{.*)$/, "");
        const ok =
          host.endsWith(".invalid") || host === "localhost" || host === "127.0.0.1";
        expect(ok, `${committedFixtures[index]}: ${match[0]}`).toBe(true);
      }
    }
  });

  it("uses no real top-level-domain hostname in feature source", () => {
    const realTld = /\b[a-z0-9-]+\.(?:com|net|org|io|dev|local|lan|home|co|app)\b/i;
    for (const [index, code] of ALL_FEATURE_CODE.entries()) {
      expect(code, ALL_FEATURE_FILES[index]).not.toMatch(realTld);
    }
  });
});

// ---------------------------------------------------------------------------
// 11. Forbidden implementation-path diff boundaries.
//     Spec 08 §10.2(11): implementation review/diff is authoritative because a
//     runtime test cannot prove historical non-editing. This guard confines the
//     feature's implementation FOOTPRINT — the feature directories own only
//     feature source, never a schema, CI, Playwright-config, or route file — and
//     documents that the diff itself is checked by review.
// ---------------------------------------------------------------------------

describe("11. confined feature implementation footprint (diff authority: review)", () => {
  it("scans a non-empty feature universe", () => {
    expect(ALL_FEATURE_FILES.length).toBeGreaterThan(0);
  });

  it("contains only .ts/.tsx feature source, no config/CI/schema/workflow files", () => {
    // A stray non-source file inside the feature dirs would be an out-of-bounds
    // artifact; the real historical-diff boundary (packages/schema, HTTP routing,
    // shell/discovery, detail pages, CI) is enforced by implementation review.
    for (const dir of [webFeatureDir, serverDriftDir]) {
      const stray = collectNonSource(dir);
      expect(stray, `unexpected non-source artifact under ${dir}`).toEqual([]);
    }
  });
});

/** Collect any file under `dir` that is not a `.ts`/`.tsx` source file. */
function collectNonSource(dir: string): string[] {
  const stray: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) stray.push(...collectNonSource(full));
    else if (!entry.name.endsWith(".ts") && !entry.name.endsWith(".tsx"))
      stray.push(full);
  }
  return stray;
}
