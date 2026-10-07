import {
  expect,
  request as apiRequest,
  test,
  type BrowserContext,
  type Locator,
  type Page,
} from "@playwright/test";
import type {
  DriftFinding,
  ObservedHost,
  ObservedService,
  SnapshotDocument,
} from "@deck/schema";
import {
  attachMutableInventoryRuntime,
  publishSnapshot,
  type MutableInventoryRuntime,
  INVENTORY_E2E_RUNTIME_ENV,
} from "./fixture-runtime.js";
import {
  buildInventoryScenario,
  buildScaleGeneration,
  FIXTURE,
} from "./inventory-fixture.js";

/**
 * Stable browser presentation of the drift-and-coverage feature against the real
 * Bun API + Vite harness (item 015). These scenarios prove routing, complete
 * finding/group/waiver/evidence/coverage rendering, both entity fragments, the
 * health-header summary, entity links, representative filters, keyboard-only
 * flow, evidence disclosure, and qualified zero drift — all through the real app
 * graph reading the two existing GET endpoints.
 *
 * The fixed E2E config the API prepared declares seven invented hosts and five
 * services (see `inventory-fixture.ts`); only the snapshot is mutable. The
 * baseline generation the API boots with carries no `snapshot.drift`, so it is
 * the qualified-zero-drift case. The drift-presentation block publishes one
 * complete generation whose only addition is an invented `drift` array, waits
 * until the real provider serves it, and restores the baseline afterwards.
 *
 * Every identity is invented under the `fixture-` / `.invalid` namespaces; no
 * estate fact is copied. Request/decode/derivation failure and atomic recovery
 * transitions are item 016 and are intentionally absent here.
 */

const enc = encodeURIComponent;

/** Fixed page heading shared by every generation state. */
const PAGE_HEADING = "Drift and collection coverage";

/** Composed provider(60s) + client(30s) + margin(5s) readiness/observation budget. */
const COMPOSED_WINDOW_MS = 95_000;

/** Invented host absent from the declared config and observed snapshot (unresolved). */
const ORPHAN_HOST = "fixture-orphan-host.invalid";

/** Invented service name absent from the model; a finding on it falls back to its host. */
const ABSENT_SERVICE = "fixture-absent-service";

/**
 * Hostile, markup-looking evidence strings. If any were ever parsed as HTML they
 * would set `window.__DRIFT_XSS__`; the security case proves that never happens
 * and that the sentinel never reaches page diagnostics. They are ordinary JSON
 * string values under the fixture namespace.
 */
const XSS_SENTINEL = "__DRIFT_XSS__";
const HOSTILE_MARKUP = `<img src=x onerror="window.${XSS_SENTINEL}=1">`;
const HOSTILE_OBSERVED = `<script>window.${XSS_SENTINEL}=1</script>`;

/** Escape a literal label for use inside an anchored regular expression. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The invented drift population. Waiver expiries are placed far in the future or
 * past relative to the run clock so the browser derivation classifies them
 * deterministically as active or expired. Ordering (host code-unit, host-level
 * before services, then severity/risk/category/id) makes `fixture-finding-001`
 * the first row and `fixture-finding-006` the second.
 */
function driftFindings(): DriftFinding[] {
  const nowMs = Date.now();
  const future = new Date(nowMs + 3650 * 24 * 60 * 60 * 1000).toISOString();
  const past = new Date(nowMs - 365 * 24 * 60 * 60 * 1000).toISOString();
  return [
    {
      id: "fixture-finding-001",
      severity: "error",
      location: { host: FIXTURE.hostAlpha },
      category: "fixture.config",
      message: "Managed config drift on the alpha host.",
      expected: "0640",
      observed: "0644",
    },
    {
      id: "fixture-finding-002",
      severity: "warning",
      location: { host: FIXTURE.hostAlpha, service: FIXTURE.serviceWeb },
      category: "fixture.service",
      message: "Replica count differs from the declaration.",
      expected: { mode: "replicated", replicas: 3 },
      observed: { mode: "single", replicas: 1 },
    },
    {
      id: "fixture-finding-003",
      severity: "info",
      location: { host: FIXTURE.hostAlpha, service: ABSENT_SERVICE },
      category: "fixture.info",
      message: "Informational drift on an unresolved service.",
      waiver: {
        reason: "Approved for fixture testing.",
        who: "fixture-owner",
        until: future,
      },
    },
    {
      id: "fixture-finding-004",
      severity: "error",
      location: { host: ORPHAN_HOST },
      category: "fixture.orphan",
      message: "Drift on a host absent from inventory.",
      waiver: {
        reason: "Waiver lapsed in the fixture.",
        who: "fixture-owner",
        until: past,
      },
    },
    {
      id: "fixture-finding-005",
      severity: "warning",
      location: { host: FIXTURE.hostBravo },
      category: "fixture.bravo",
      message: "Host-level drift on bravo with an open-ended waiver.",
      waiver: { reason: "Indefinite fixture waiver.", who: "fixture-owner" },
    },
    {
      id: "fixture-finding-006",
      severity: "error",
      location: { host: FIXTURE.hostAlpha },
      category: "fixture.evidence",
      message: "Large evidence drift on the alpha host.",
      expected: { note: HOSTILE_MARKUP, big: "A".repeat(3000) },
      observed: HOSTILE_OBSERVED,
    },
  ];
}

/** One complete generation identical to the baseline plus the invented drift array. */
function buildDriftSnapshot(nowMs: number): SnapshotDocument {
  const { snapshot } = buildInventoryScenario(nowMs);
  return { ...snapshot, drift: driftFindings() };
}

/** The no-drift baseline generation used to restore the runtime after mutation. */
function baselineSnapshot(nowMs: number): SnapshotDocument {
  return buildInventoryScenario(nowMs).snapshot;
}

/** Poll the real provider until the served snapshot reports the given drift count. */
async function waitForServedDriftCount(expected: number): Promise<void> {
  const api = await apiRequest.newContext({ baseURL: `http://127.0.0.1:${process.env.DECK_E2E_API_PORT ?? 8788}` });
  try {
    await expect
      .poll(
        async () => {
          const response = await api.get("/api/providers/snapshot");
          if (!response.ok()) return -1;
          const body = (await response.json()) as {
            data?: { snapshot?: { drift?: unknown[] } } | null;
          };
          const drift = body.data?.snapshot?.drift;
          return Array.isArray(drift) ? drift.length : 0;
        },
        { timeout: COMPOSED_WINDOW_MS, intervals: [500, 1000, 2000] },
      )
      .toBe(expected);
  } finally {
    await api.dispose();
  }
}

/** Assert a `<dt>/<dd>` overview pair renders exactly one label→value cell. */
async function expectOverviewPair(
  overview: Locator,
  label: string,
  value: string,
): Promise<void> {
  const cell = overview
    .locator("div")
    .filter({ hasText: new RegExp(`^${escapeRegExp(label + value)}$`) });
  await expect(cell, `overview ${label} = ${value}`).toHaveCount(1);
}

/**
 * Navigate to a fresh app route, retrying the load if the Vite dev server serves
 * a blank shell (an occasional cold-transform miss under heavy CPU contention).
 * The shell banner renders on every successful app mount, so it is the universal
 * readiness signal. (See the CPU-contention note in the feature progress log.)
 */
async function gotoApp(page: Page, path: string): Promise<void> {
  await expect(async () => {
    await page.goto(path);
    await expect(page.getByRole("banner")).toBeVisible({ timeout: 15_000 });
  }).toPass({ timeout: 60_000, intervals: [1000, 2000, 4000] });
}

/**
 * Open `/drift` and wait for the available presentation to mount. The H1 renders
 * in every state, so waiting for the Overview region confirms `DriftAvailable`
 * (and its search input plus keydown listener) is present before any interaction.
 */
async function openDrift(page: Page): Promise<void> {
  await gotoApp(page, "/drift");
  await expect(
    page.getByRole("heading", { name: PAGE_HEADING, level: 1 }),
  ).toBeVisible();
  await expect(page.getByRole("region", { name: "Overview" })).toBeVisible();
}

/** Stable hooks for the mounted keyboard results (finding rows, coverage rows). */
const FINDING_ROWS = 'li[id^="drift-finding-"]';
const COVERAGE_ROWS = 'tr[id^="drift-coverage-"]';

/**
 * Toggle one option of a drift facet filter: open the facet's popover from its
 * trigger in the "Drift filters" search landmark, click the option, then close
 * the popover with Escape.
 */
async function toggleFacet(page: Page, facet: string, option: string): Promise<void> {
  const filters = page.getByRole("search", { name: "Drift filters" });
  await filters
    .getByRole("button", { name: new RegExp(`^${escapeRegExp(facet)}`) })
    .click();
  const listbox = page.getByRole("listbox", { name: facet });
  await listbox.getByRole("option", { name: option, exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(listbox).toHaveCount(0);
}

// ---------------------------------------------------------------------------
// Qualified zero drift — the baseline generation the API boots with carries no
// drift, so these run before any runtime mutation. (SC-05)
// ---------------------------------------------------------------------------

test.describe("qualified zero drift (baseline generation)", () => {
  test("the page reports no drift while retaining coverage and freshness", async ({
    page,
  }) => {
    await openDrift(page);

    await expect(
      page.getByRole("status").filter({ hasText: "No drift reported." }),
    ).toBeVisible();

    // Coverage is retained and complete even with zero drift.
    const table = page.getByRole("table");
    await expect(
      table
        .getByRole("row")
        .filter({ hasText: FIXTURE.hostDelta })
        .getByText("Unreachable", { exact: true }),
    ).toBeVisible();

    const overview = page.getByRole("region", { name: "Overview" });
    await expectOverviewPair(overview, "Error", "0");
    await expectOverviewPair(overview, "Warning", "0");
    await expectOverviewPair(overview, "Info", "0");
    await expectOverviewPair(overview, "Total coverage hosts", "8");
  });

  test("a host fragment qualifies its empty state by host collection", async ({
    page,
  }) => {
    await gotoApp(page, `/hosts/${enc(FIXTURE.hostAlpha)}`);
    await expect(
      page.getByRole("heading", { name: `Host: ${FIXTURE.hostAlpha}`, level: 1 }),
    ).toBeVisible();
    const slot = page.locator('[data-entity-slot="findings"]');
    await expect(
      slot.getByText(
        "No drift reported for this entity in the current snapshot. Host collection is fresh.",
      ),
    ).toBeVisible();
  });

  test("the health header reports no active drift", async ({ page }) => {
    await gotoApp(page, "/");
    // The shell-owned health-header region hosts multiple self-sufficient summary
    // fragments; scope to the drift contribution by its /drift href.
    const link = page.locator('[data-slot="health-header"] a[href="/drift"]');
    await expect(link).toHaveAttribute("href", "/drift");
    await expect(link).toContainText("No active drift");
  });
});

// ---------------------------------------------------------------------------
// Complete drift presentation — publishes one invented drift generation, proves
// the full read-only presentation, then restores the baseline.
// ---------------------------------------------------------------------------

test.describe("drift presentation (published generation)", () => {
  let runtime!: MutableInventoryRuntime;

  test.beforeAll(async () => {
    test.setTimeout(COMPOSED_WINDOW_MS + 30_000);
    const rootDir = process.env[INVENTORY_E2E_RUNTIME_ENV];
    expect(rootDir, "runtime root env is published before workers fork").toBeTruthy();
    runtime = await attachMutableInventoryRuntime(rootDir!);
    await publishSnapshot(runtime, buildDriftSnapshot(Date.now()));
    await waitForServedDriftCount(6);
  });

  test.afterAll(async () => {
    // Restore the runtime to the no-drift baseline for later spec files.
    await publishSnapshot(runtime, baselineSnapshot(Date.now()));
  });

  test("the primary nav link and a direct URL both open the Drift page", async ({
    page,
  }) => {
    await gotoApp(page, "/");
    await page
      .getByRole("navigation", { name: "Primary" })
      .getByRole("link", { name: "Drift", exact: true })
      .click();
    await expect(page).toHaveURL(/\/drift$/);
    await expect(
      page.getByRole("heading", { name: PAGE_HEADING, level: 1 }),
    ).toBeVisible();

    await openDrift(page);
  });

  test("every finding renders exactly once, grouped by host with waiver detail", async ({
    page,
  }) => {
    await openDrift(page);

    await expect(page.locator(FINDING_ROWS)).toHaveCount(6);
    for (const suffix of ["001", "002", "003", "004", "005", "006"]) {
      await expect(
        page.locator(`[id="drift-finding-fixture-finding-${suffix}"]`),
      ).toHaveCount(1);
    }

    // Three host groups in code-unit order: alpha, bravo, then the orphan host.
    await expect(
      page.getByRole("heading", { name: `Host: ${FIXTURE.hostAlpha}` }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: `Host: ${FIXTURE.hostBravo}` }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: `Host: ${ORPHAN_HOST}` }),
    ).toBeVisible();

    // Explicit waiver labels (icon is decorative; text is authoritative).
    await expect(
      page
        .locator('[id="drift-finding-fixture-finding-003"]')
        .getByText("Active waiver")
        .first(),
    ).toBeVisible();
    await expect(
      page
        .locator('[id="drift-finding-fixture-finding-004"]')
        .getByText("Expired waiver")
        .first(),
    ).toBeVisible();

    // Absent evidence is distinguished from supplied values.
    await expect(
      page
        .locator('[id="drift-finding-fixture-finding-003"]')
        .getByText("Expected: Not supplied"),
    ).toBeVisible();
    await expect(
      page
        .locator('[id="drift-finding-fixture-finding-001"]')
        .locator('[data-drift-evidence="Expected"]'),
    ).toBeVisible();
  });

  test("the overview reports complete-generation severity, waiver, and coverage counts", async ({
    page,
  }) => {
    await openDrift(page);
    const overview = page.getByRole("region", { name: "Overview" });

    await expectOverviewPair(overview, "Error", "3");
    await expectOverviewPair(overview, "Warning", "1");
    await expectOverviewPair(overview, "Info", "0");
    await expectOverviewPair(overview, "Active", "2");
    await expectOverviewPair(overview, "Expired", "1");
    await expectOverviewPair(overview, "Fresh", "4");
    await expectOverviewPair(overview, "Stale", "1");
    await expectOverviewPair(overview, "Partial", "1");
    await expectOverviewPair(overview, "Unreachable", "1");
    await expectOverviewPair(overview, "Never collected", "1");
    await expectOverviewPair(overview, "Total coverage hosts", "8");
  });

  test("the coverage table renders all five states, collectors, and host links", async ({
    page,
  }) => {
    await openDrift(page);
    const table = page.getByRole("table");
    await expect(table).toBeVisible();

    const states: ReadonlyArray<readonly [string, string]> = [
      [FIXTURE.hostAlpha, "Fresh"],
      [FIXTURE.hostBravo, "Stale"],
      [FIXTURE.hostCharlie, "Partial"],
      [FIXTURE.hostDelta, "Unreachable"],
      [FIXTURE.hostEcho, "Never collected"],
    ];
    for (const [host, state] of states) {
      const row = table.getByRole("row").filter({ hasText: host });
      await expect(row.getByText(state, { exact: true })).toBeVisible();
    }

    // The partial host discloses its failed collector; a resolvable host links out.
    const charlie = table.getByRole("row").filter({ hasText: FIXTURE.hostCharlie });
    await expect(charlie.getByText("1 failed collectors")).toBeVisible();
    await expect(
      charlie.getByRole("link", { name: FIXTURE.hostCharlie }),
    ).toHaveAttribute("href", `/hosts/${enc(FIXTURE.hostCharlie)}`);
  });

  test("finding locations resolve to service, host fallback, or explicit unresolved text", async ({
    page,
  }) => {
    await openDrift(page);

    // Resolvable service → service detail link.
    await expect(
      page
        .locator('[id="drift-finding-fixture-finding-002"]')
        .getByRole("link", {
          name: `View service ${FIXTURE.serviceWeb} on ${FIXTURE.hostAlpha}`,
        }),
    ).toHaveAttribute(
      "href",
      `/services/${enc(FIXTURE.hostAlpha)}/${enc(FIXTURE.serviceWeb)}`,
    );

    // Unresolved service falls back to its resolvable host.
    await expect(
      page
        .locator('[id="drift-finding-fixture-finding-003"]')
        .getByRole("link", { name: `View host ${FIXTURE.hostAlpha}` }),
    ).toHaveAttribute("href", `/hosts/${enc(FIXTURE.hostAlpha)}`);

    // Wholly unresolved host → explicit text and no anchor.
    const orphan = page.locator('[id="drift-finding-fixture-finding-004"]');
    await expect(orphan.getByRole("link")).toHaveCount(0);
    await expect(
      orphan.getByText(
        "Location unresolved; no host or service detail link is available.",
      ),
    ).toBeVisible();
  });

  test("the host detail fragment scopes to the host and round-trips to /drift", async ({
    page,
  }) => {
    await gotoApp(page, `/hosts/${enc(FIXTURE.hostAlpha)}`);
    const slot = page.locator('[data-entity-slot="findings"]');
    await expect(
      slot.getByRole("heading", {
        name: `Drift findings for host ${FIXTURE.hostAlpha}`,
      }),
    ).toBeVisible();
    // Host scope flattens host-level and every service subgroup: 4 alpha findings.
    await expect(
      slot.getByRole("status").filter({ hasText: "4 scoped findings" }),
    ).toBeVisible();
    await expect(
      slot.getByText("Active risk: 2 error, 1 warning, 0 info."),
    ).toBeVisible();

    await slot
      .getByRole("link", { name: "View these findings in the Drift view" })
      .click();
    await expect(page).toHaveURL(/\/drift\?host=fixture-host-alpha$/);
    await expect(
      page
        .getByRole("status")
        .filter({ hasText: `Entity scope: host ${FIXTURE.hostAlpha}` }),
    ).toBeVisible();
  });

  test("the service detail fragment scopes to exactly (host, service) and round-trips", async ({
    page,
  }) => {
    await gotoApp(page, `/services/${enc(FIXTURE.hostAlpha)}/${enc(FIXTURE.serviceWeb)}`);
    const slot = page.locator('[data-entity-slot="findings"]');
    await expect(
      slot.getByRole("heading", {
        name: `Drift findings for service ${FIXTURE.serviceWeb} on ${FIXTURE.hostAlpha}`,
      }),
    ).toBeVisible();
    // Service scope includes only the exact (host, service) subgroup: 1 finding.
    await expect(
      slot.getByRole("status").filter({ hasText: "1 scoped finding" }),
    ).toBeVisible();

    await slot
      .getByRole("link", { name: "View these findings in the Drift view" })
      .click();
    await expect(page).toHaveURL(/\/drift\?host=fixture-host-alpha&service=web$/);
    await expect(
      page
        .getByRole("status")
        .filter({
          hasText: `Entity scope: service ${FIXTURE.serviceWeb} on ${FIXTURE.hostAlpha}`,
        }),
    ).toBeVisible();
  });

  test("the health header contributes a linked drift summary from the same generation", async ({
    page,
  }) => {
    await gotoApp(page, "/");
    // Scope to the drift contribution — the region now hosts sibling fragments too.
    const link = page.locator('[data-slot="health-header"] a[href="/drift"]');
    await expect(link).toHaveAttribute("href", "/drift");
    await expect(link).toHaveAttribute("data-drift-summary-state", "down");
    await expect(link).toContainText("Error: 3 active");
    await expect(link).toContainText("4 of 8 hosts need coverage attention");
    await expect(link).toContainText("2 active waivers");
    await expect(link).toContainText("1 expired waiver");
  });

  test("finding and coverage filters compose and stay independent", async ({
    page,
  }) => {
    await openDrift(page);
    const status = () => page.getByRole("status").filter({ hasText: "Showing" });

    // A finding facet narrows findings (3 error findings) but not coverage.
    await toggleFacet(page, "Severity", "Error");
    await expect(status()).toContainText("Showing 3 of 6 findings");
    await expect(status()).toContainText("showing 8 of 8 coverage hosts");
    await toggleFacet(page, "Severity", "Error");
    await expect(status()).toContainText("Showing 6 of 6 findings");

    // A coverage facet narrows coverage (1 unreachable host) but not findings.
    await toggleFacet(page, "Coverage state", "Unreachable");
    await expect(status()).toContainText("Showing 6 of 6 findings");
    await expect(status()).toContainText("showing 1 of 8 coverage hosts");
    await toggleFacet(page, "Coverage state", "Unreachable");

    // Text search narrows to one finding by its exact id.
    const search = page.getByRole("searchbox", { name: "Search drift findings" });
    await search.fill("fixture-finding-002");
    await expect(status()).toContainText("Showing 1 of 6 findings");
    await expect(
      page.locator('[id="drift-finding-fixture-finding-002"]'),
    ).toHaveCount(1);
    await expect(
      page.locator('[id="drift-finding-fixture-finding-001"]'),
    ).toHaveCount(0);
  });

  test("keyboard-only search focus and Escape operate without a mouse", async ({
    page,
  }) => {
    await openDrift(page);
    const search = page.getByRole("searchbox", { name: "Search drift findings" });
    const status = page.getByRole("status").filter({ hasText: "Showing" });

    // `/` focuses search from the document body and is not typed. The page's one
    // keydown listener attaches in a mount effect that can land a frame after the
    // content is visible, so retry the press until the listener is live.
    await expect(async () => {
      await page.keyboard.press("/");
      await expect(search).toBeFocused({ timeout: 1000 });
    }).toPass({ timeout: 15_000, intervals: [250, 500, 1000] });
    await expect(search).toHaveValue("");

    await page.keyboard.type("fixture-finding-002");
    await expect(search).toHaveValue("fixture-finding-002");
    await expect(status).toContainText("Showing 1 of 6 findings");

    // Escape clears the search text and keeps focus in the search input.
    await page.keyboard.press("Escape");
    await expect(search).toHaveValue("");
    await expect(status).toContainText("Showing 6 of 6 findings");
  });

  test("keyboard-only result navigation opens a focused finding's detail link", async ({
    page,
  }) => {
    await openDrift(page);
    const first = page.locator('[id="drift-finding-fixture-finding-001"]');
    const second = page.locator('[id="drift-finding-fixture-finding-006"]');
    // Focus starts on the document body, so result-movement keys are handled.
    await expect(first).toBeVisible();

    // Home focuses the first result; retry until the keydown listener is live.
    await expect(async () => {
      await page.keyboard.press("Home");
      await expect(first).toBeFocused({ timeout: 1000 });
    }).toPass({ timeout: 15_000, intervals: [250, 500, 1000] });

    await page.keyboard.press("ArrowDown");
    await expect(second).toBeFocused();

    // Return to the first result and open it with Enter through the app graph.
    await page.keyboard.press("Home");
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(new RegExp(`/hosts/${escapeRegExp(FIXTURE.hostAlpha)}$`));
    await expect(
      page.getByRole("heading", { name: `Host: ${FIXTURE.hostAlpha}`, level: 1 }),
    ).toBeVisible();
  });

  test("evidence inspection and waiver disclosure controls operate and restore focus", async ({
    page,
  }) => {
    await openDrift(page);
    const evidenceRow = page.locator('[id="drift-finding-fixture-finding-006"]');
    await evidenceRow.scrollIntoViewIfNeeded();

    // The large evidence value is initially bounded; inspection reveals the full text.
    const inspect = evidenceRow.getByRole("button", {
      name: "Inspect full expected value",
    });
    await expect(inspect).toBeVisible();
    await inspect.click();
    const full = evidenceRow.locator('pre[aria-label="Full expected value"]');
    await expect(full).toBeVisible();
    await expect(full).toContainText('"big"');

    // Collapse restores focus to the same toggling control.
    await evidenceRow
      .getByRole("button", { name: "Collapse full expected value" })
      .click();
    await expect(full).toHaveCount(0);
    await expect(inspect).toBeFocused();

    // The waiver details on an active-waiver finding expand its metadata.
    const waived = page.locator('[id="drift-finding-fixture-finding-003"]');
    await waived.getByRole("button", { name: "Waiver details" }).click();
    await expect(waived.getByText("Approved for fixture testing.")).toBeVisible();
    await expect(waived.getByText("fixture-owner").first()).toBeVisible();
  });

  test("hostile evidence stays inert and never reaches page diagnostics", async ({
    page,
  }) => {
    const diagnostics: string[] = [];
    page.on("pageerror", (error) => diagnostics.push(String(error)));
    page.on("console", (message) => {
      if (message.type() === "error") diagnostics.push(message.text());
    });

    await openDrift(page);
    const evidenceRow = page.locator('[id="drift-finding-fixture-finding-006"]');
    await evidenceRow.scrollIntoViewIfNeeded();

    // The hostile observed string renders as inert framework text.
    await expect(evidenceRow).toContainText(XSS_SENTINEL);
    // Render the full expected value, which embeds the markup-looking note.
    await evidenceRow
      .getByRole("button", { name: "Inspect full expected value" })
      .click();
    await expect(
      evidenceRow.locator('pre[aria-label="Full expected value"]'),
    ).toBeVisible();

    // No markup was parsed into an element and no injected global fired.
    await expect(page.locator("img[onerror]")).toHaveCount(0);
    const fired = await page.evaluate(
      () => (window as unknown as Record<string, unknown>).__DRIFT_XSS__ ?? null,
    );
    expect(fired).toBeNull();

    for (const line of diagnostics) {
      expect(line, "page diagnostics").not.toContain(XSS_SENTINEL);
    }
  });

  test("feature traffic uses only GET config/snapshot requests and normal navigation", async ({
    page,
  }) => {
    const offending: string[] = [];
    let sawConfig = false;
    let sawSnapshot = false;
    page.on("request", (request) => {
      const method = request.method();
      const url = request.url();
      if (method !== "GET") offending.push(`${method} ${url}`);
      if (/\/api\/drift/.test(url)) offending.push(`drift-endpoint ${url}`);
      if (url.includes("/api/config")) sawConfig = true;
      if (url.includes("/api/providers/snapshot")) sawSnapshot = true;
    });

    await openDrift(page);
    // Exercise filtering and a scoped navigation; neither issues a write.
    await toggleFacet(page, "Severity", "Error");
    await expect(
      page.getByRole("status").filter({ hasText: "Showing 3 of 6 findings" }),
    ).toBeVisible();
    await page
      .locator('[id="drift-finding-fixture-finding-001"]')
      .getByRole("link", { name: `View host ${FIXTURE.hostAlpha}` })
      .click();
    await expect(
      page.getByRole("heading", { name: `Host: ${FIXTURE.hostAlpha}`, level: 1 }),
    ).toBeVisible();

    expect(sawConfig, "config GET observed").toBe(true);
    expect(sawSnapshot, "snapshot GET observed").toBe(true);
    expect(offending, "no write or drift-endpoint requests").toEqual([]);
  });
});

// ===========================================================================
// Item 016 — failure retention and atomic recovery.
//
// These blocks are independent of the stable-presentation coverage above. They
// prove the no-usable-generation classification states (no-config, pending,
// failed-empty, failed-first request, failed-first derivation) and the retained
// request/decode/derivation failure → later-valid recovery sequence, all through
// the real browser drift/inventory store graph reading the two existing GET
// endpoints. State is driven by read-only HTTP interception (spec 08 §3 permits
// interception for these classification and browser-failure paths), never by a
// test-only production endpoint, non-GET operation, persistence, or retry.
//
// The retention/recovery block installs Playwright's clock so the drift store's
// real 30s poll interval can be advanced deterministically inside one open page
// (no reload), and mutates only an in-test response variable. Because each test
// gets a fresh Playwright browser context — and therefore fresh in-page module
// singletons — runtime, interception, clock, diagnostic, focus, and global state
// are restored between cases automatically; the shared invented runtime file is
// never mutated here, so later spec files are unaffected.
// ===========================================================================

/** JSON object alias for hand-built provider envelopes. */
type JsonObject = Record<string, unknown>;

/** A staged snapshot response the interceptor serves on the next poll. */
type StagedSnapshot =
  | { readonly kind: "json"; readonly body: JsonObject }
  | { readonly kind: "status"; readonly status: number }
  | { readonly kind: "malformed" };

/**
 * Fixed browser clock. Waivers are omitted from these fixtures, so derivation is
 * deterministic without depending on wall time; the clock only lets the store's
 * poll interval be advanced explicitly.
 */
const FIXED_CLOCK = new Date("2035-01-15T12:00:00.000Z");

/** Build one invented, schema-shaped drift finding without a waiver. */
function makeFinding(
  id: string,
  severity: "error" | "warning" | "info",
  host: string,
  service?: string,
): DriftFinding {
  const location = service === undefined ? { host } : { host, service };
  return {
    id,
    severity,
    location,
    category: `fixture.${severity}`,
    message: `Invented ${severity} drift ${id}.`,
  };
}

/**
 * Build one complete snapshot provider envelope the inventory store accepts as
 * `available`. Omitting `generatedAt` keeps the envelope inventory-valid (the
 * model builds) while making drift derivation throw `INVALID_INPUT` — the exact
 * browser failed-derivation path. `readError` surfaces the provider's retained
 * read failure through the accepted projection.
 */
function availableEnvelope(opts: {
  readonly drift: readonly DriftFinding[];
  readonly generatedAt?: string | null;
  readonly readError?: { readonly code: string; readonly message: string } | null;
}): JsonObject {
  const observedAt = FIXED_CLOCK.toISOString();
  const snapshot: JsonObject = {
    schemaVersion: 1,
    hosts: [
      { name: FIXTURE.hostAlpha, coverage: "collected", collectedAt: observedAt, reachable: true },
      { name: FIXTURE.hostDelta, coverage: "unreachable", reachable: false },
    ],
    services: [],
    drift: [...opts.drift],
  };
  // Include generatedAt unless it is explicitly nulled (derivation-failure case).
  if (opts.generatedAt !== null) {
    snapshot.generatedAt = opts.generatedAt ?? observedAt;
  }
  return {
    id: "snapshot",
    kind: "snapshot",
    freshness: { state: "fresh", observedAt, ageMs: 0, ttlMs: 60_000 },
    data: {
      snapshot,
      findings: [],
      hostStates: {
        [FIXTURE.hostAlpha]: { state: "fresh", pastStaleThreshold: false, collectedAt: observedAt },
        [FIXTURE.hostDelta]: { state: "unreachable", pastStaleThreshold: false, collectedAt: null },
      },
      lastReadAt: observedAt,
      readError: opts.readError ?? null,
    },
    error: null,
  };
}

/** Gen A: one active error (alpha) and one active warning (bravo). */
const GEN_A_DRIFT: readonly DriftFinding[] = [
  makeFinding("fixture-a-error", "error", FIXTURE.hostAlpha),
  makeFinding("fixture-a-warning", "warning", FIXTURE.hostBravo),
];

/** Gen C: a single active info finding — a distinct population from gen A. */
const GEN_C_DRIFT: readonly DriftFinding[] = [
  makeFinding("fixture-c-info", "info", FIXTURE.hostAlpha),
];

/** Fulfil one intercepted snapshot poll from the current staged response. */
async function fulfilStaged(
  route: import("@playwright/test").Route,
  staged: StagedSnapshot,
): Promise<void> {
  if (staged.kind === "status") {
    await route.fulfill({ status: staged.status, contentType: "application/json", body: "{}" });
    return;
  }
  if (staged.kind === "malformed") {
    await route.fulfill({ status: 200, contentType: "application/json", body: "{ not valid json" });
    return;
  }
  await route.fulfill({ json: staged.body });
}

/**
 * Install the clock, intercept the snapshot endpoint with a mutable staged
 * response, and open `/drift`. The returned `advance` swaps the staged response
 * and fires exactly one poll interval so the live page transitions in place.
 */
async function openStagedDrift(
  page: Page,
  initial: StagedSnapshot,
): Promise<{ advance(next: StagedSnapshot): Promise<void> }> {
  await page.clock.install({ time: FIXED_CLOCK });
  const box: { current: StagedSnapshot } = { current: initial };
  await page.route("**/api/providers/snapshot", (route) =>
    fulfilStaged(route, box.current),
  );
  await gotoApp(page, "/drift");
  await expect(
    page.getByRole("heading", { name: PAGE_HEADING, level: 1 }),
  ).toBeVisible();
  return {
    async advance(next: StagedSnapshot): Promise<void> {
      box.current = next;
      // Fire the store's 30s poll interval; the routed fetch resolves in real time.
      await page.clock.fastForward(30_000);
    },
  };
}

/** The three retained-failure banners the page renders above the overview. */
const RETAINED_REQUEST_BANNER = "Latest inventory request failed; showing retained data.";
const RETAINED_READ_BANNER = "Latest snapshot read failed; showing the last successful snapshot.";
const RETAINED_DERIVE_BANNER =
  "Latest drift derivation failed; showing the previous complete generation.";

/** Assert no retained-failure banner is present (a fully recovered generation). */
async function expectNoRetainedBanners(page: Page): Promise<void> {
  for (const text of [RETAINED_REQUEST_BANNER, RETAINED_READ_BANNER, RETAINED_DERIVE_BANNER]) {
    await expect(page.getByText(text)).toHaveCount(0);
  }
}

/** Assert the gen-A population is shown exactly (error+warning, no gen-C finding). */
async function expectGenA(page: Page): Promise<void> {
  const overview = page.getByRole("region", { name: "Overview" });
  await expectOverviewPair(overview, "Error", "1");
  await expectOverviewPair(overview, "Warning", "1");
  await expectOverviewPair(overview, "Info", "0");
  await expect(page.locator('[id="drift-finding-fixture-a-error"]')).toHaveCount(1);
  await expect(page.locator('[id="drift-finding-fixture-c-info"]')).toHaveCount(0);
}

/** Assert the gen-C population is shown exactly (info only, no gen-A findings). */
async function expectGenC(page: Page): Promise<void> {
  const overview = page.getByRole("region", { name: "Overview" });
  await expectOverviewPair(overview, "Error", "0");
  await expectOverviewPair(overview, "Warning", "0");
  await expectOverviewPair(overview, "Info", "1");
  await expect(page.locator('[id="drift-finding-fixture-c-info"]')).toHaveCount(1);
  await expect(page.locator('[id="drift-finding-fixture-a-error"]')).toHaveCount(0);
  await expect(page.locator('[id="drift-finding-fixture-a-warning"]')).toHaveCount(0);
}

// ---------------------------------------------------------------------------
// Pre-success classification states (read-only interception, no fabricated
// counts). Each is a fresh page whose snapshot endpoint is intercepted before
// the first poll. (SC-06, spec 08 §6.2, §8.1)
// ---------------------------------------------------------------------------

test.describe("no-usable-generation classification (read-only interception)", () => {
  test("a 404 renders the no-snapshot-configured status with no counts", async ({
    page,
  }) => {
    await page.route("**/api/providers/snapshot", (route) =>
      route.fulfill({ status: 404, contentType: "application/json", body: "{}" }),
    );
    await gotoApp(page, "/drift");
    await expect(
      page.getByRole("status").filter({ hasText: "No snapshot is configured." }),
    ).toBeVisible();
    await expect(page.getByRole("region", { name: "Overview" })).toHaveCount(0);
  });

  test("a pending envelope renders the waiting status with no counts", async ({
    page,
  }) => {
    await page.route("**/api/providers/snapshot", (route) =>
      route.fulfill({
        json: {
          id: "snapshot",
          kind: "snapshot",
          freshness: { state: "pending", observedAt: null, ageMs: null, ttlMs: null },
          data: null,
          error: null,
        },
      }),
    );
    await gotoApp(page, "/drift");
    await expect(
      page.getByRole("status").filter({ hasText: "Waiting for the first snapshot read." }),
    ).toBeVisible();
    await expect(page.getByRole("region", { name: "Overview" })).toHaveCount(0);
  });

  test("a failed-empty envelope renders the upstream read alert with no counts", async ({
    page,
  }) => {
    await page.route("**/api/providers/snapshot", (route) =>
      route.fulfill({
        json: {
          id: "snapshot",
          kind: "snapshot",
          freshness: { state: "unreachable", observedAt: null, ageMs: null, ttlMs: null },
          data: null,
          error: { code: "POLL_TIMEOUT", message: "Snapshot read failed." },
        },
      }),
    );
    await gotoApp(page, "/drift");
    await expect(
      page
        .getByRole("alert")
        .filter({ hasText: "Snapshot read failed; no retained snapshot is available." }),
    ).toBeVisible();
    await expect(page.getByRole("region", { name: "Overview" })).toHaveCount(0);
  });

  test("a first-request HTTP error renders the request alert with no counts", async ({
    page,
  }) => {
    await page.route("**/api/providers/snapshot", (route) =>
      route.fulfill({ status: 500, contentType: "application/json", body: "{}" }),
    );
    await gotoApp(page, "/drift");
    await expect(
      page
        .getByRole("alert")
        .filter({ hasText: "Snapshot request failed; no retained snapshot is available." }),
    ).toBeVisible();
    await expect(page.getByRole("region", { name: "Overview" })).toHaveCount(0);
  });

  test("a first-derivation failure renders the derivation alert with no counts", async ({
    page,
  }) => {
    // An inventory-valid available envelope whose snapshot omits generatedAt: the
    // model builds, but drift derivation throws INVALID_INPUT.
    await page.route("**/api/providers/snapshot", (route) =>
      route.fulfill({ json: availableEnvelope({ drift: GEN_A_DRIFT, generatedAt: null }) }),
    );
    await gotoApp(page, "/drift");
    await expect(
      page.getByRole("alert").filter({ hasText: "Drift view could not be derived." }),
    ).toBeVisible();
    await expect(page.getByText("Drift data could not be prepared.")).toBeVisible();
    await expect(page.getByRole("region", { name: "Overview" })).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------
// Retained failure and atomic recovery in one live page (no reload). Interception
// plus the installed clock drive the store's real polls; each transition is
// asserted before the next. (SC-07, spec 08 §6.2, §8.4)
// ---------------------------------------------------------------------------

test.describe("retained failure and atomic recovery (live interception + clock)", () => {
  test("a browser request failure retains the exact prior generation, then recovers atomically", async ({
    page,
  }) => {
    const drift = await openStagedDrift(page, {
      kind: "json",
      body: availableEnvelope({ drift: GEN_A_DRIFT }),
    });
    await expectGenA(page);

    // Request failure: the store keeps the exact accepted generation and adds only
    // the sanitized transient warning.
    await drift.advance({ kind: "status", status: 503 });
    await expect(page.getByText(RETAINED_REQUEST_BANNER)).toBeVisible();
    await expectGenA(page);

    // A later valid, distinct generation swaps every surface at once and clears the
    // warning — no gen-A finding survives beside gen-C counts.
    await drift.advance({ kind: "json", body: availableEnvelope({ drift: GEN_C_DRIFT }) });
    await expectGenC(page);
    await expectNoRetainedBanners(page);
  });

  test("a browser decode failure retains the prior generation, then recovers atomically", async ({
    page,
  }) => {
    const drift = await openStagedDrift(page, {
      kind: "json",
      body: availableEnvelope({ drift: GEN_A_DRIFT }),
    });
    await expectGenA(page);

    // A malformed 200 body decodes to a retained transient failure, not a new
    // generation; the exact prior bundle stays visible.
    await drift.advance({ kind: "malformed" });
    await expect(page.getByText(RETAINED_REQUEST_BANNER)).toBeVisible();
    await expectGenA(page);

    await drift.advance({ kind: "json", body: availableEnvelope({ drift: GEN_C_DRIFT }) });
    await expectGenC(page);
    await expectNoRetainedBanners(page);
  });

  test("a browser derivation failure retains the prior generation, then recovers atomically", async ({
    page,
  }) => {
    const drift = await openStagedDrift(page, {
      kind: "json",
      body: availableEnvelope({ drift: GEN_A_DRIFT }),
    });
    await expectGenA(page);

    // An accepted available generation that cannot derive retains the prior bundle
    // and surfaces only the fixed derivation warning.
    await drift.advance({
      kind: "json",
      body: availableEnvelope({ drift: GEN_C_DRIFT, generatedAt: null }),
    });
    await expect(page.getByText(RETAINED_DERIVE_BANNER)).toBeVisible();
    await expectGenA(page);

    await drift.advance({ kind: "json", body: availableEnvelope({ drift: GEN_C_DRIFT }) });
    await expectGenC(page);
    await expectNoRetainedBanners(page);
  });

  test("a retained provider read failure keeps findings visible and clears on recovery", async ({
    page,
  }) => {
    const drift = await openStagedDrift(page, {
      kind: "json",
      body: availableEnvelope({ drift: GEN_A_DRIFT }),
    });
    await expectGenA(page);

    // Provider-level retained read failure: a fresh available generation carrying
    // the last-good findings plus a readError. Findings stay; the read banner shows.
    await drift.advance({
      kind: "json",
      body: availableEnvelope({
        drift: GEN_A_DRIFT,
        readError: { code: "POLL_TIMEOUT", message: "Snapshot read failed." },
      }),
    });
    await expect(page.getByText(RETAINED_READ_BANNER)).toBeVisible();
    await expectGenA(page);

    await drift.advance({ kind: "json", body: availableEnvelope({ drift: GEN_C_DRIFT }) });
    await expectGenC(page);
    await expectNoRetainedBanners(page);
  });

  test("repeated identical generations never regress to an older population", async ({
    page,
  }) => {
    const drift = await openStagedDrift(page, {
      kind: "json",
      body: availableEnvelope({ drift: GEN_A_DRIFT }),
    });
    await expectGenA(page);

    await drift.advance({ kind: "json", body: availableEnvelope({ drift: GEN_C_DRIFT }) });
    await expectGenC(page);

    // A duplicate identical response is idempotent: the page stays on gen C and the
    // superseded gen-A population never reappears.
    await drift.advance({ kind: "json", body: availableEnvelope({ drift: GEN_C_DRIFT }) });
    await expectGenC(page);
    await expectNoRetainedBanners(page);
  });
});

// ---------------------------------------------------------------------------
// Structured diagnostics carry only the allowlisted keys and never leak source
// or caught-error content. (SC-14, spec 08 §5.6, §6.6)
// ---------------------------------------------------------------------------

test.describe("drift diagnostics allowlist (live interception + clock)", () => {
  /** Exact §5.6 key allowlists. */
  const DERIVE_KEYS = [
    "durationMs",
    "event",
    "findingsCount",
    "hostCount",
    "outcome",
    "refreshGeneration",
    "snapshotGeneratedAt",
  ];
  const RENDER_KEYS = [
    "durationMs",
    "event",
    "findingsCount",
    "hostCount",
    "outcome",
    "refreshGeneration",
    "surface",
  ];

  test("derive and render diagnostics expose only allowlisted keys with no leaked content", async ({
    page,
  }) => {
    // The default sink logs the structured event object as the first console
    // argument; capture those objects in page context without touching modules.
    await page.addInitScript(() => {
      const w = window as unknown as { __driftEvents?: unknown[] };
      w.__driftEvents = [];
      for (const level of ["info", "error", "warn", "log"] as const) {
        const original = console[level].bind(console);
        console[level] = (...args: unknown[]): void => {
          const first = args[0] as { event?: unknown } | null;
          if (
            first !== null &&
            typeof first === "object" &&
            (first.event === "drift.derive" || first.event === "drift.render")
          ) {
            try {
              w.__driftEvents!.push(JSON.parse(JSON.stringify(first)));
            } catch {
              /* ignore non-serializable */
            }
          }
          original(...(args as []));
        };
      }
    });

    const drift = await openStagedDrift(page, {
      kind: "json",
      body: availableEnvelope({ drift: GEN_A_DRIFT }),
    });
    await expectGenA(page);
    // Drive a derivation failure then a recovery so both derive outcomes emit.
    await drift.advance({
      kind: "json",
      body: availableEnvelope({ drift: GEN_C_DRIFT, generatedAt: null }),
    });
    await expect(page.getByText(RETAINED_DERIVE_BANNER)).toBeVisible();
    await drift.advance({ kind: "json", body: availableEnvelope({ drift: GEN_C_DRIFT }) });
    await expectGenC(page);

    await expect
      .poll(async () =>
        (await page.evaluate(
          () => (window as unknown as { __driftEvents: unknown[] }).__driftEvents.length,
        )),
      )
      .toBeGreaterThan(0);

    const events = (await page.evaluate(
      () => (window as unknown as { __driftEvents: unknown[] }).__driftEvents,
    )) as Array<Record<string, unknown>>;

    const deriveEvents = events.filter((event) => event.event === "drift.derive");
    const renderEvents = events.filter((event) => event.event === "drift.render");
    expect(deriveEvents.length, "derive diagnostics emitted").toBeGreaterThan(0);
    expect(renderEvents.length, "render diagnostics emitted").toBeGreaterThan(0);

    // No finding id, message, host name, or category can appear anywhere.
    const forbidden = [
      "fixture-a-error",
      "fixture-a-warning",
      "fixture-c-info",
      "Invented",
      FIXTURE.hostAlpha,
      FIXTURE.hostBravo,
      "fixture.error",
      "fixture.info",
    ];
    for (const event of events) {
      const keys = Object.keys(event).sort();
      const allowed = event.event === "drift.derive" ? DERIVE_KEYS : RENDER_KEYS;
      expect(keys, "only allowlisted keys").toEqual([...allowed].sort());
      const serialized = JSON.stringify(event);
      for (const needle of forbidden) {
        expect(serialized, "no leaked source content").not.toContain(needle);
      }
    }
  });
});

// ===========================================================================
// Item 019 — Chromium performance gates and above-scale reachability.
//
// Chromium is authoritative for the complete-page render/update (< 1,000 ms) and
// composed filter/search (< 100 ms) budgets (spec 08 §6.5, §9). The fixed E2E
// config declares 7 hosts and 5 services; only the snapshot is mutable, so
// `buildScaleGeneration` publishes a generation whose declared ∪ observed union
// is exactly 150 hosts and 300 services, and these blocks add the required drift
// arrays. Each gate publishes its generation, waits until the real Bun API serves
// it, measures with one unmeasured warm-up plus three valid samples, records only
// durations and safe ids/counts, and restores the no-drift baseline afterwards.
// No hard cap, dependency, generated-artifact check, CI edit, skip, persistence,
// endpoint, or claim of unbounded capacity is introduced.
// ===========================================================================

/** Composed provider(60s) + client(30s) + margin(5s) readiness budget. */
const PERF_COMPOSED_WINDOW_MS = 95_000;
/** Per-sample assertion budget once a response has completed. */
const PERF_ASSERT_TIMEOUT_MS = 15_000;

/** Closed severity vocabulary cycled across the scale drift population. */
const SCALE_SEVERITIES = ["error", "warning", "info"] as const;

/** The 150 host identities the scale generation's declared ∪ observed union renders. */
function scaleHostNames(): string[] {
  const declared = [
    FIXTURE.hostAlpha,
    FIXTURE.hostBravo,
    FIXTURE.hostCharlie,
    FIXTURE.hostDelta,
    FIXTURE.hostEcho,
    FIXTURE.hostFoxtrot,
    FIXTURE.hostEncoded,
  ];
  const scale = Array.from(
    { length: 143 },
    (_unused, index) => `fixture-scale-host-${String(index).padStart(3, "0")}`,
  );
  return [...declared, ...scale];
}

/** The number of host groups the exact-scale drift population concentrates into. */
const SCALE_FINDING_GROUPS = 5;
/** The bounded finding rows the page commits initially (25 per concentrated group). */
const SCALE_INITIAL_FINDING_ROWS = SCALE_FINDING_GROUPS * 25;

/**
 * Build the exact 1,000-finding scale drift population. The findings concentrate
 * host-level into five large subgroups so the page's real progressive-disclosure
 * bound (25 initial rows per subgroup) governs the committed DOM, rather than a
 * pathological one-row-per-host spread. The complete generation still reports the
 * full 1,000 total; only the initially rendered rows are bounded.
 */
function scaleDriftFindings(): DriftFinding[] {
  const hosts = scaleHostNames();
  return Array.from({ length: 1000 }, (_unused, index) => ({
    id: `fixture-finding-${String(index).padStart(4, "0")}`,
    severity: SCALE_SEVERITIES[index % SCALE_SEVERITIES.length]!,
    location: { host: hosts[index % SCALE_FINDING_GROUPS]! },
    category: `fixture.cat${index % 5}`,
    message: `Invented scale drift ${index}.`,
  }));
}

/** One complete scale generation: exactly 150 hosts, 300 services, 1,000 findings. */
function scaleDriftSnapshot(nowMs: number): SnapshotDocument {
  const { snapshot } = buildScaleGeneration(nowMs);
  return { ...snapshot, drift: scaleDriftFindings() };
}

/** The no-drift baseline restored after each perf block mutates the runtime. */
function perfBaselineSnapshot(nowMs: number): SnapshotDocument {
  return buildInventoryScenario(nowMs).snapshot;
}

/** Poll the real provider until it serves the required host-state and drift counts. */
async function waitForServedScale(
  expectedHosts: number,
  expectedDrift: number,
): Promise<void> {
  const api = await apiRequest.newContext({ baseURL: `http://127.0.0.1:${process.env.DECK_E2E_API_PORT ?? 8788}` });
  try {
    await expect
      .poll(
        async () => {
          const response = await api.get("/api/providers/snapshot");
          if (!response.ok()) return "not-ok";
          const body = (await response.json()) as {
            data?: {
              hostStates?: Record<string, unknown>;
              snapshot?: { drift?: unknown[] };
            } | null;
          };
          if (!body.data) return "no-data";
          const hosts = Object.keys(body.data.hostStates ?? {}).length;
          const drift = Array.isArray(body.data.snapshot?.drift)
            ? body.data.snapshot!.drift!.length
            : 0;
          return `${hosts}:${drift}`;
        },
        { timeout: PERF_COMPOSED_WINDOW_MS, intervals: [500, 1000, 2000] },
      )
      .toBe(`${expectedHosts}:${expectedDrift}`);
  } finally {
    await api.dispose();
  }
}

test.describe("browser performance gates (exact 150/300/1,000 scale)", () => {
  /** Findings whose source severity is error (deterministic facet population). */
  const SCALE_ERROR_COUNT = scaleDriftFindings().filter(
    (finding) => finding.severity === "error",
  ).length;
  /** A single existing finding id used for the search-filter operation. */
  const SEARCH_ID = "fixture-finding-0500";
  /**
   * A coverage host used for the coverage host+state operation. The coverage-host
   * facet lists only hosts that carry findings, and the scale population
   * concentrates findings into the first host groups, so this is one of them; its
   * observed collection is fresh, so composing it with the fresh state yields one
   * matching coverage row.
   */
  const COVERAGE_HOST = FIXTURE.hostAlpha;
  /**
   * The composed all-finding-facet population for the severity operation. The
   * text, host, category, and waiver criteria are pre-activated UNTIMED so the
   * single severity toggle is measured against a fully composed finding filter.
   * Each is span-complete over the scale population — the query matches every
   * message, the hosts are exactly the finding-bearing groups, the categories
   * are every emitted category, and every finding is unwaived — so none removes
   * a finding on its own; only the final severity toggle narrows the result to
   * the error subset. This makes the composed result exactly `SCALE_ERROR_COUNT`
   * while exercising every finding predicate on the timed path.
   */
  const COMPOSED_TEXT_QUERY = "scale drift";
  const COMPOSED_FINDING_HOSTS = scaleHostNames().slice(0, SCALE_FINDING_GROUPS);
  const COMPOSED_CATEGORIES = Array.from(
    new Set(scaleDriftFindings().map((finding) => finding.category)),
  );

  let runtime!: MutableInventoryRuntime;

  test.beforeAll(async () => {
    test.setTimeout(PERF_COMPOSED_WINDOW_MS + 30_000);
    const rootDir = process.env[INVENTORY_E2E_RUNTIME_ENV];
    expect(rootDir, "runtime root env is published before workers fork").toBeTruthy();
    runtime = await attachMutableInventoryRuntime(rootDir!);
    const snapshot = scaleDriftSnapshot(Date.now());
    expect(snapshot.hosts?.length, "scale snapshot host count").toBe(150);
    expect(snapshot.services?.length, "scale snapshot service count").toBe(300);
    expect(snapshot.drift?.length, "scale snapshot drift count").toBe(1000);
    await publishSnapshot(runtime, snapshot);
    await waitForServedScale(150, 1000);
  });

  test.afterAll(async () => {
    await publishSnapshot(runtime, perfBaselineSnapshot(Date.now()));
  });

  /**
   * One fresh-context initial-render sample: the interval spans the later of the
   * two API response completions through the complete-generation page commit
   * (H1, exact 1,000/150 status, all 1,000 finding rows, the initial 25-row
   * coverage batch). Fixture generation, startup, navigation, and network
   * transfer are outside the measured interval.
   */
  async function sampleDriftRender(context: BrowserContext): Promise<number> {
    const page = await context.newPage();
    const pageErrors: Error[] = [];
    page.on("pageerror", (error) => pageErrors.push(error));

    const configResponse = page.waitForResponse((r) => r.url().includes("/api/config"));
    const snapshotResponse = page.waitForResponse((r) =>
      r.url().includes("/api/providers/snapshot"),
    );
    await page.goto("/drift");
    const [config, snapshotEnvelope] = await Promise.all([
      configResponse,
      snapshotResponse,
    ]);
    expect(config.ok(), "config response 2xx").toBe(true);
    expect(snapshotEnvelope.ok(), "snapshot response 2xx").toBe(true);
    await Promise.all([config.finished(), snapshotEnvelope.finished()]);

    const start = performance.now();
    await expect(
      page.getByRole("heading", { name: PAGE_HEADING, level: 1 }),
    ).toBeVisible({ timeout: PERF_ASSERT_TIMEOUT_MS });
    const status = page.getByRole("status").filter({ hasText: "Showing 1000 of 1000" });
    await expect(status).toBeVisible({ timeout: PERF_ASSERT_TIMEOUT_MS });
    await expect(status).toContainText(
      `across ${SCALE_FINDING_GROUPS} host groups`,
      { timeout: PERF_ASSERT_TIMEOUT_MS },
    );
    await expect(status).toContainText("showing 150 of 150 coverage hosts", {
      timeout: PERF_ASSERT_TIMEOUT_MS,
    });
    // The complete generation commits its bounded initial finding rows and the
    // initial 25-row coverage batch (progressive disclosure governs the DOM).
    await expect(page.locator(FINDING_ROWS)).toHaveCount(
      SCALE_INITIAL_FINDING_ROWS,
      { timeout: PERF_ASSERT_TIMEOUT_MS },
    );
    await expect(page.locator(COVERAGE_ROWS)).toHaveCount(25, {
      timeout: PERF_ASSERT_TIMEOUT_MS,
    });
    const elapsed = performance.now() - start;

    expect(Number.isFinite(elapsed), "render interval is finite").toBe(true);
    expect(elapsed, "render interval is non-negative").toBeGreaterThanOrEqual(0);
    expect(pageErrors, "no uncaught page error").toHaveLength(0);
    await page.close();
    return elapsed;
  }

  test("initial /drift render commits the complete 1,000-finding / 150-host generation under 1,000 ms", async ({
    browser,
  }) => {
    test.setTimeout(180_000);
    // One unmeasured warm-up, then exactly three valid measured samples.
    const warm = await browser.newContext();
    try {
      await sampleDriftRender(warm);
    } finally {
      await warm.close();
    }
    const samples: number[] = [];
    for (let sample = 0; sample < 3; sample += 1) {
      const context = await browser.newContext();
      try {
        samples.push(await sampleDriftRender(context));
      } finally {
        await context.close();
      }
    }
    // eslint-disable-next-line no-console
    console.info("drift.e2e.render", { samples, fastestMs: Math.min(...samples) });
    expect(Math.min(...samples), `render samples ${samples.join(", ")} ms`).toBeLessThan(
      1000,
    );
  });

  test("composed search, all-finding-facet, and coverage filters each commit under 100 ms", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const pageErrors: Error[] = [];
    page.on("pageerror", (error) => pageErrors.push(error));

    // Filtering must trigger no network request; count API traffic after the page
    // has settled and assert it stays zero across the timed operations.
    let settled = false;
    let apiDuringFilter = 0;
    page.on("request", (request) => {
      if (settled && request.url().includes("/api/")) apiDuringFilter += 1;
    });

    await gotoApp(page, "/drift");
    await expect(
      page.getByRole("heading", { name: PAGE_HEADING, level: 1 }),
    ).toBeVisible();
    await expect(page.locator(FINDING_ROWS)).toHaveCount(
      SCALE_INITIAL_FINDING_ROWS,
      { timeout: PERF_ASSERT_TIMEOUT_MS },
    );
    await expect(
      page.getByRole("status").filter({ hasText: "showing 150 of 150 coverage hosts" }),
    ).toBeVisible();
    settled = true;

    /**
     * Run one filter operation entirely in the browser realm: one unmeasured
     * warm-up plus three measured samples, each timed from the input/change
     * dispatch until the polite status commits the exact expected substring and
     * one further animation frame elapses. Between samples the control is reset to
     * baseline untimed. Returns the three sample durations.
     */
    const measureFilter = (
      opType: "search" | "severity" | "coverage",
      expected: string,
      searchValue: string,
      coverageHost: string,
      composeText: string,
      composeHosts: readonly string[],
      composeCategories: readonly string[],
    ): Promise<number[]> =>
      page.evaluate(
        async ({
          opType,
          expected,
          searchValue,
          coverageHost,
          composeText,
          composeHosts,
          composeCategories,
        }) => {
          const raf = (): Promise<void> =>
            new Promise((resolve) => requestAnimationFrame(() => resolve()));
          const statusText = (): string =>
            Array.from(document.querySelectorAll('[role="status"]'))
              .map((node) => node.textContent ?? "")
              .join(" ");
          const waitFor = async (predicate: () => boolean): Promise<void> => {
            const deadline = performance.now() + 5000;
            while (!predicate()) {
              if (performance.now() > deadline) {
                throw new Error(`timeout; status was: ${statusText()}`);
              }
              await raf();
            }
          };
          // Each facet is a popover listbox that exists only while open: find the
          // facet's trigger in the "Drift filters" landmark, open it if needed,
          // and address the option by its value (`host:`-prefixed for the
          // host/service facet). Opening is untimed setup; only the option click
          // (the toggle) is inside a measured sample.
          const filterRegion = document.querySelector(
            '[role="search"][aria-label="Drift filters"]',
          );
          if (!filterRegion) throw new Error("no drift filter region");
          const listboxFor = (title: string): Element | null =>
            Array.from(document.querySelectorAll('[role="listbox"]')).find(
              (candidate) => candidate.getAttribute("aria-label") === title,
            ) ?? null;
          const openFacet = async (title: string): Promise<Element> => {
            const existing = listboxFor(title);
            if (existing) return existing;
            const trigger = Array.from(
              filterRegion.querySelectorAll<HTMLButtonElement>("button[aria-expanded]"),
            ).find((candidate) => (candidate.textContent ?? "").trim().startsWith(title));
            if (!trigger) throw new Error(`no facet trigger ${title}`);
            trigger.click();
            await waitFor(() => listboxFor(title) !== null);
            return listboxFor(title)!;
          };
          const facetOption = async (title: string, value: string): Promise<HTMLElement> => {
            const listbox = await openFacet(title);
            const option = Array.from(
              listbox.querySelectorAll<HTMLElement>('[role="option"]'),
            ).find((candidate) => candidate.getAttribute("data-value") === value);
            if (!option) throw new Error(`no ${title} option ${value}`);
            return option;
          };
          const isChecked = (option: HTMLElement): boolean =>
            option.getAttribute("aria-checked") === "true";
          const optionChecked = (title: string, value: string): boolean =>
            Array.from(listboxFor(title)?.querySelectorAll('[role="option"]') ?? []).some(
              (candidate) =>
                candidate.getAttribute("data-value") === value &&
                candidate.getAttribute("aria-checked") === "true",
            );
          const searchInput = filterRegion.querySelector(
            'input[type="search"]',
          ) as HTMLInputElement | null;
          if (!searchInput) throw new Error("no search input");
          const nativeValueSetter = Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype,
            "value",
          )!.set!;

          const setSearch = (value: string): void => {
            nativeValueSetter.call(searchInput, value);
            searchInput.dispatchEvent(new Event("input", { bubbles: true }));
          };
          // Toggle as a user activation does: cmdk selects an option on click.
          const toggle = (option: HTMLElement): void => {
            option.click();
          };

          // The single timed action per operation. The severity case composes a
          // severity facet onto pre-selected text/host/category/waiver criteria,
          // and the coverage case composes a host facet onto a pre-selected
          // coverage state, so each timed action is one toggle (two synchronous
          // change dispatches would read stale filter state and clobber one
          // another — the real UI re-renders between clicks).
          // The timed option is resolved (and its popover opened) before t0.
          const target = async (): Promise<HTMLElement | null> => {
            if (opType === "search") return null;
            return opType === "severity"
              ? facetOption("Severity", "error")
              : facetOption("Coverage host", coverageHost);
          };
          const apply = (option: HTMLElement | null): void => {
            if (option === null) setSearch(searchValue);
            else toggle(option);
          };
          const reset = async (): Promise<void> => {
            const option = await target();
            if (option === null) setSearch("");
            else if (isChecked(option)) toggle(option);
          };
          // Establish the composed baseline once. The coverage operation keeps a
          // coverage-state facet active so the timed host toggle yields a genuine
          // host+state composition. The severity operation pre-activates the full
          // finding-facet set (text + host + category + waiver) so the single
          // timed severity toggle is measured against a composed finding filter.
          // Each criterion is applied and allowed to re-render before the next so
          // the controlled filter state is never clobbered by a stale read.
          const preselect = async (): Promise<void> => {
            if (opType === "coverage") {
              const state = await facetOption("Coverage state", "fresh");
              if (!isChecked(state)) toggle(state);
              await waitFor(() =>
                statusText().includes("showing 150 of 150 coverage hosts"),
              );
              return;
            }
            if (opType === "severity") {
              setSearch(composeText);
              await waitFor(
                () =>
                  searchInput.value === composeText &&
                  statusText().includes("Local filters active"),
              );
              for (const host of composeHosts) {
                const option = await facetOption("Host/service", `host:${host}`);
                if (!isChecked(option)) toggle(option);
                await waitFor(() => optionChecked("Host/service", `host:${host}`));
              }
              for (const category of composeCategories) {
                const option = await facetOption("Category", category);
                if (!isChecked(option)) toggle(option);
                await waitFor(() => optionChecked("Category", category));
              }
              const waiver = await facetOption("Waiver status", "unwaived");
              if (!isChecked(waiver)) toggle(waiver);
              await waitFor(() => optionChecked("Waiver status", "unwaived"));
              // None of the composed facets removes a finding, so the composed
              // baseline still shows all 1,000 findings with local filters active.
              await waitFor(
                () =>
                  statusText().includes("Showing 1000 of 1000 findings") &&
                  statusText().includes("Local filters active"),
              );
            }
          };
          const atBaseline = (): boolean => {
            if (opType === "coverage") {
              return statusText().includes("showing 150 of 150 coverage hosts");
            }
            if (opType === "severity") {
              // Composed baseline: every non-severity facet active, no severity.
              return (
                statusText().includes("Showing 1000 of 1000 findings") &&
                statusText().includes("Local filters active")
              );
            }
            return (
              statusText().includes("Showing 1000 of 1000 findings") &&
              !statusText().includes("Local filters active")
            );
          };
          const ensureBaseline = async (): Promise<void> => {
            await reset();
            await waitFor(atBaseline);
          };
          const sample = async (): Promise<number> => {
            const option = await target();
            const t0 = performance.now();
            apply(option);
            await waitFor(() => statusText().includes(expected));
            await raf();
            return performance.now() - t0;
          };

          await preselect();
          await ensureBaseline();
          await sample(); // unmeasured warm-up
          await ensureBaseline();
          const durations: number[] = [];
          for (let index = 0; index < 3; index += 1) {
            durations.push(await sample());
            await ensureBaseline();
          }
          return durations;
        },
        {
          opType,
          expected,
          searchValue,
          coverageHost,
          composeText,
          composeHosts,
          composeCategories,
        },
      );

    const searchSamples = await measureFilter(
      "search",
      `Showing 1 of 1000 findings`,
      SEARCH_ID,
      COVERAGE_HOST,
      COMPOSED_TEXT_QUERY,
      COMPOSED_FINDING_HOSTS,
      COMPOSED_CATEGORIES,
    );
    // eslint-disable-next-line no-console
    console.info("drift.e2e.filter.search", {
      samples: searchSamples,
      fastestMs: Math.min(...searchSamples),
    });
    expect(
      Math.min(...searchSamples),
      `search samples ${searchSamples.join(", ")} ms`,
    ).toBeLessThan(100);

    const facetSamples = await measureFilter(
      "severity",
      `Showing ${SCALE_ERROR_COUNT} of 1000 findings`,
      SEARCH_ID,
      COVERAGE_HOST,
      COMPOSED_TEXT_QUERY,
      COMPOSED_FINDING_HOSTS,
      COMPOSED_CATEGORIES,
    );
    // eslint-disable-next-line no-console
    console.info("drift.e2e.filter.facet", {
      samples: facetSamples,
      fastestMs: Math.min(...facetSamples),
      filteredFindingCount: SCALE_ERROR_COUNT,
    });
    expect(
      Math.min(...facetSamples),
      `facet samples ${facetSamples.join(", ")} ms`,
    ).toBeLessThan(100);

    const coverageSamples = await measureFilter(
      "coverage",
      `showing 1 of 150 coverage hosts`,
      SEARCH_ID,
      COVERAGE_HOST,
      COMPOSED_TEXT_QUERY,
      COMPOSED_FINDING_HOSTS,
      COMPOSED_CATEGORIES,
    );
    // eslint-disable-next-line no-console
    console.info("drift.e2e.filter.coverage", {
      samples: coverageSamples,
      fastestMs: Math.min(...coverageSamples),
    });
    expect(
      Math.min(...coverageSamples),
      `coverage samples ${coverageSamples.join(", ")} ms`,
    ).toBeLessThan(100);

    // Correctness: each operation commits its exact expected filtered result.
    await page.getByRole("searchbox", { name: "Search drift findings" }).fill(SEARCH_ID);
    await expect(
      page.getByRole("status").filter({ hasText: "Showing 1 of 1000 findings" }),
    ).toBeVisible();
    await expect(page.locator(`[id="drift-finding-${SEARCH_ID}"]`)).toHaveCount(1);

    expect(pageErrors, "no uncaught page error during filtering").toHaveLength(0);
    expect(apiDuringFilter, "filtering issues no network request").toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Above-scale browser reachability and evidence responsiveness (spec 08 §9.4).
//
// A strictly above-scale generation (160 hosts, 320 services, 1,010 findings)
// with one concentrated finding subgroup and > 25 coverage rows. It proves that
// complete totals are retained, the final finding and coverage identities are
// reachable through progressive controls, a genuinely large evidence value stays
// bounded until inspection, and an unrelated control still responds while that
// inspection is scheduled. No numeric above-scale duration is asserted; the normal
// Playwright timeout detects hangs.
// ---------------------------------------------------------------------------

/** The concentrated subgroup identity carrying more than 25 findings. */
const ABOVE_SCALE_SUBGROUP_HOST = "fixture-scale-host-000";
const ABOVE_SCALE_SUBGROUP_SERVICE = "fixture-scale-svc-a";

/** The 160 host identities the above-scale generation observes. */
function aboveScaleHostNames(): string[] {
  const declared = [
    FIXTURE.hostAlpha,
    FIXTURE.hostBravo,
    FIXTURE.hostCharlie,
    FIXTURE.hostDelta,
    FIXTURE.hostEcho,
    FIXTURE.hostFoxtrot,
    FIXTURE.hostEncoded,
  ];
  const scale = Array.from(
    { length: 153 },
    (_unused, index) => `fixture-scale-host-${String(index).padStart(3, "0")}`,
  );
  return [...declared, ...scale];
}

/** Build one strictly above-scale generation: 160 hosts, 320 services, 1,010 findings. */
function aboveScaleDriftSnapshot(nowMs: number): SnapshotDocument {
  const collectedAt = new Date(nowMs).toISOString();
  const hostNames = aboveScaleHostNames();
  const scaleHosts = hostNames.slice(7);
  const hosts: ObservedHost[] = hostNames.map((name) => ({
    name,
    coverage: "collected",
    collectedAt,
    reachable: true,
  }));
  const services: ObservedService[] = [
    { host: FIXTURE.hostAlpha, name: FIXTURE.serviceWeb, state: "running" },
    { host: FIXTURE.hostAlpha, name: FIXTURE.serviceDb, state: "running" },
    { host: FIXTURE.hostBravo, name: FIXTURE.serviceWeb, state: "running" },
    { host: FIXTURE.hostFoxtrot, name: FIXTURE.serviceCache, state: "running" },
    { host: FIXTURE.hostEncoded, name: FIXTURE.serviceEncoded, state: "running" },
    ...Array.from({ length: 315 }, (_unused, index) => ({
      host: scaleHosts[index % scaleHosts.length]!,
      name: `fixture-scale-svc-${String(index).padStart(3, "0")}`,
      state: "running" as const,
    })),
  ];

  const drift: DriftFinding[] = [];
  // 30 concentrated findings in one (host, service) subgroup; the first carries a
  // genuinely large evidence value that exceeds the preview byte bound.
  for (let index = 0; index < 30; index += 1) {
    const finding: DriftFinding = {
      id: `fixture-finding-${String(index).padStart(4, "0")}`,
      severity: "warning",
      location: {
        host: ABOVE_SCALE_SUBGROUP_HOST,
        service: ABOVE_SCALE_SUBGROUP_SERVICE,
      },
      category: "fixture.concentrated",
      message: `Invented concentrated drift ${index}.`,
    };
    if (index === 0) {
      finding.expected = { note: "bounded", big: "A".repeat(4000) };
    }
    drift.push(finding);
  }
  // Remaining host-level findings distributed across the estate for a total above scale.
  for (let index = 30; index < 1010; index += 1) {
    drift.push({
      id: `fixture-finding-${String(index).padStart(4, "0")}`,
      severity: SCALE_SEVERITIES[index % SCALE_SEVERITIES.length]!,
      location: { host: hostNames[index % hostNames.length]! },
      category: `fixture.cat${index % 5}`,
      message: `Invented above-scale drift ${index}.`,
    });
  }

  const snapshot: SnapshotDocument = {
    schemaVersion: 1,
    generatedAt: collectedAt,
    hosts,
    services,
    drift,
  };
  if (
    hosts.length !== 160 ||
    services.length !== 320 ||
    (snapshot.drift?.length ?? 0) !== 1010
  ) {
    throw new Error("Above-scale generation must be 160 hosts, 320 services, 1010 findings.");
  }
  return snapshot;
}

test.describe("above-scale browser reachability and evidence responsiveness", () => {
  let runtime!: MutableInventoryRuntime;

  test.beforeAll(async () => {
    test.setTimeout(PERF_COMPOSED_WINDOW_MS + 30_000);
    const rootDir = process.env[INVENTORY_E2E_RUNTIME_ENV];
    expect(rootDir, "runtime root env is published before workers fork").toBeTruthy();
    runtime = await attachMutableInventoryRuntime(rootDir!);
    await publishSnapshot(runtime, aboveScaleDriftSnapshot(Date.now()));
    await waitForServedScale(160, 1010);
  });

  test.afterAll(async () => {
    await publishSnapshot(runtime, perfBaselineSnapshot(Date.now()));
  });

  test("retains complete totals and reaches the final concentrated finding through show-all", async ({
    page,
  }) => {
    await openDrift(page);
    await expect(
      page.getByRole("status").filter({ hasText: "of 1010 findings" }),
    ).toBeVisible();

    // The concentrated subgroup shows the initial 25; its final row (id 0029) is hidden.
    const finalRow = page.locator('[id="drift-finding-fixture-finding-0029"]');
    await expect(finalRow).toHaveCount(0);
    await page
      .getByRole("button", {
        name: `Show all 30 findings in ${ABOVE_SCALE_SUBGROUP_SERVICE} on ${ABOVE_SCALE_SUBGROUP_HOST}`,
      })
      .click();
    await expect(finalRow).toHaveCount(1);
  });

  test("reaches the final coverage host through show-all", async ({ page }) => {
    await openDrift(page);
    await expect(page.locator(COVERAGE_ROWS)).toHaveCount(25);
    await page
      .getByRole("button", { name: "Show all 160 coverage hosts" })
      .click();
    await expect(page.locator(COVERAGE_ROWS)).toHaveCount(160);
  });

  test("keeps a large evidence value bounded and unrelated controls responsive during inspection", async ({
    page,
  }) => {
    await openDrift(page);
    const bigRow = page.locator('[id="drift-finding-fixture-finding-0000"]');
    await bigRow.scrollIntoViewIfNeeded();

    // The large evidence value is initially bounded behind an inspection control.
    const inspect = bigRow.getByRole("button", {
      name: "Inspect full expected value",
    });
    await expect(inspect).toBeVisible();
    await expect(
      bigRow.locator('pre[aria-label="Full expected value"]'),
    ).toHaveCount(0);

    // Schedule the full evidence render, then immediately drive an unrelated
    // control. A coverage-state facet is independent of findings, so it responds
    // without removing the large-evidence finding whose value is being prepared.
    await inspect.click();
    await toggleFacet(page, "Coverage state", "Stale");
    await expect(
      page
        .getByRole("status")
        .filter({ hasText: "showing 0 of 160 coverage hosts" }),
    ).toBeVisible();

    // The scheduled full evidence value also completes — neither blocks the other.
    await expect(
      bigRow.locator('pre[aria-label="Full expected value"]'),
    ).toBeVisible();
  });
});
