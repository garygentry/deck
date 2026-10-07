import { stat } from "node:fs/promises";
import {
  expect,
  request as apiRequest,
  test,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import type { SnapshotDocument } from "@deck/schema";
import {
  attachMutableInventoryRuntime,
  publishMalformedSnapshot,
  publishSnapshot,
  publishTornSnapshot,
  type MutableInventoryRuntime,
  INVENTORY_E2E_RUNTIME_ENV,
} from "./fixture-runtime.js";
import {
  buildInventoryScenario,
  buildScaleGeneration,
  FIXTURE,
} from "./inventory-fixture.js";

/**
 * Core observable inventory scenarios against the real Bun API + Vite harness.
 *
 * Every selector is role/name based except the `data-entity-slot` contract marker.
 * These scenarios read the single invented rich fixture the API serves (see
 * `inventory-fixture.ts`); the no-data client states are simulated with read-only
 * request interception (a route-level 404/crafted envelope), never a write
 * endpoint. Keyboard-only flows, contrast, live source mutation/recovery, and
 * timed render gates belong to later items and are not asserted here.
 */

const enc = encodeURIComponent;

/** Navigate to an inventory list and wait for its heading plus the available snapshot. */
async function openList(page: Page, path: "/hosts" | "/services"): Promise<void> {
  await page.goto(path);
  const heading = path === "/hosts" ? "Hosts" : "Services";
  await expect(page.getByRole("heading", { name: heading, level: 1 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Snapshot available" })).toBeVisible();
}

/** Parse a `#rrggbb`/`#rgb` or `rgb()/rgba()` colour string to `[r,g,b]` (0–255). */
function toRgb(color: string): [number, number, number] {
  const value = color.trim();
  if (value.startsWith("#")) {
    const hex = value.slice(1);
    const full =
      hex.length === 3
        ? hex
            .split("")
            .map((digit) => digit + digit)
            .join("")
        : hex;
    return [
      Number.parseInt(full.slice(0, 2), 16),
      Number.parseInt(full.slice(2, 4), 16),
      Number.parseInt(full.slice(4, 6), 16),
    ];
  }
  const match = value.match(/rgba?\(([^)]+)\)/);
  if (match === null) throw new Error(`Unparseable colour: ${color}`);
  const parts = match[1].split(",").map((part) => Number.parseFloat(part.trim()));
  return [parts[0], parts[1], parts[2]];
}

/** WCAG relative luminance of an sRGB colour. */
function relativeLuminance([r, g, b]: [number, number, number]): number {
  const channel = (raw: number): number => {
    const srgb = raw / 255;
    return srgb <= 0.03928 ? srgb / 12.92 : Math.pow((srgb + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast ratio between two colour strings; symmetric, 1…21. */
function contrastRatio(a: string, b: string): number {
  const lumA = relativeLuminance(toRgb(a));
  const lumB = relativeLuminance(toRgb(b));
  const light = Math.max(lumA, lumB);
  const dark = Math.min(lumA, lumB);
  return (light + 0.05) / (dark + 0.05);
}

/** Per-list scenario data shared by the keyboard, accessibility, and contrast blocks. */
const LIST_CASES = [
  {
    path: "/hosts",
    label: "Hosts",
    captionPattern: /Hosts inventory/,
    searchName: "Search hosts",
    filterFacets: ["Kind", "Freshness"],
    columns: ["Name", "Kind", "Purpose", "Declared services", "Collection", "Observed services"],
    rowHeaderText: FIXTURE.hostAlpha,
    total: 8,
    query: "alpha",
    queryVisible: 1,
    excludeName: "Exclude hidden hosts",
    excludeVisible: 7,
    firstDetailHeading: `Host: ${FIXTURE.hostEncoded}`,
  },
  {
    path: "/services",
    label: "Services",
    captionPattern: /Services inventory/,
    searchName: "Search services",
    filterFacets: ["Host", "Observed state"],
    columns: [
      "Name",
      "Host",
      "Kind",
      "Lifecycle",
      "Purpose",
      "Observed state",
      "Host collection",
    ],
    rowHeaderText: FIXTURE.serviceEncoded,
    total: 7,
    query: "database",
    queryVisible: 1,
    excludeName: "Exclude hidden services",
    excludeVisible: 6,
    firstDetailHeading: `Service: ${FIXTURE.serviceEncoded}`,
  },
] as const;

test.describe("harness and provider contract", () => {
  test("worker attaches to the same prepared runtime as the API", async () => {
    const rootDir = process.env[INVENTORY_E2E_RUNTIME_ENV];
    expect(rootDir, "runtime root env is published before workers fork").toBeTruthy();
    const runtime = await attachMutableInventoryRuntime(rootDir!);
    expect(runtime.rootDir).toBe(rootDir);
    expect((await stat(runtime.configDir)).isDirectory()).toBe(true);
    expect((await stat(runtime.snapshotPath)).isFile()).toBe(true);
  });

  test("provider id, kind, and exact five result keys are observable over the API", async ({
    request,
  }) => {
    const response = await request.get("/api/providers/snapshot");
    expect(response.status()).toBe(200);
    const envelope = (await response.json()) as {
      id?: string;
      kind?: string;
      data?: Record<string, unknown> | null;
    };
    expect(envelope.id).toBe("snapshot");
    expect(envelope.kind).toBe("snapshot");

    // The first provider poll is immediate; allow for it to settle before the keys assert.
    await expect
      .poll(async () => {
        const poll = await request.get("/api/providers/snapshot");
        const body = (await poll.json()) as { data?: Record<string, unknown> | null };
        return body.data ? Object.keys(body.data).sort().join(",") : null;
      })
      .toBe("findings,hostStates,lastReadAt,readError,snapshot");
  });
});

test.describe("navigation and routing", () => {
  test("exactly two inventory nav links; detail labels are hidden", async ({ page }) => {
    await page.goto("/hosts");
    const nav = page.getByRole("navigation", { name: "Primary" });
    await expect(nav.getByRole("link", { name: "Hosts", exact: true })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Services", exact: true })).toBeVisible();
    // The nav-hidden dynamic detail routes never surface their labels in navigation.
    await expect(nav.getByRole("link", { name: "Host", exact: true })).toHaveCount(0);
    await expect(nav.getByRole("link", { name: "Service", exact: true })).toHaveCount(0);
  });

  test("all four inventory routes render as feature pages, not the shell fallback", async ({
    page,
  }) => {
    await page.goto("/hosts");
    await expect(page.getByRole("heading", { name: "Hosts", level: 1 })).toBeVisible();
    await page.goto("/services");
    await expect(page.getByRole("heading", { name: "Services", level: 1 })).toBeVisible();
    await page.goto(`/hosts/${enc(FIXTURE.hostAlpha)}`);
    await expect(
      page.getByRole("heading", { name: `Host: ${FIXTURE.hostAlpha}`, level: 1 }),
    ).toBeVisible();
    await page.goto(`/services/${enc(FIXTURE.hostAlpha)}/${enc(FIXTURE.serviceWeb)}`);
    await expect(
      page.getByRole("heading", { name: `Service: ${FIXTURE.serviceWeb}`, level: 1 }),
    ).toBeVisible();
  });

  test("independently encoded detail identities resolve direct and linked", async ({
    page,
  }) => {
    // Direct: the encoded host name (space + slash) is one encoded route segment.
    await page.goto(`/hosts/${enc(FIXTURE.hostEncoded)}`);
    await expect(
      page.getByRole("heading", { name: `Host: ${FIXTURE.hostEncoded}`, level: 1 }),
    ).toBeVisible();

    // Linked: the encoded service is reachable from the encoded host's services table.
    await page.goto(`/services/${enc(FIXTURE.hostEncoded)}/${enc(FIXTURE.serviceEncoded)}`);
    await expect(
      page.getByRole("heading", { name: `Service: ${FIXTURE.serviceEncoded}`, level: 1 }),
    ).toBeVisible();
    // The host segment is encoded independently and links back to the host route.
    await expect(
      page.getByRole("link", { name: FIXTURE.hostEncoded }).first(),
    ).toHaveAttribute("href", `/hosts/${enc(FIXTURE.hostEncoded)}`);
  });

  test("a hosts-list row link navigates to the encoded host detail", async ({ page }) => {
    await openList(page, "/hosts");
    const rowLink = page
      .getByRole("rowheader")
      .getByRole("link", { name: FIXTURE.hostEncoded, exact: true });
    await expect(rowLink).toHaveAttribute("href", `/hosts/${enc(FIXTURE.hostEncoded)}`);
    await rowLink.click();
    await expect(
      page.getByRole("heading", { name: `Host: ${FIXTURE.hostEncoded}`, level: 1 }),
    ).toBeVisible();
  });
});

test.describe("hosts list state distinctions", () => {
  test("every collection state, undeclared, and hidden host renders", async ({ page }) => {
    await openList(page, "/hosts");
    await expect(page.getByRole("status").filter({ hasText: /Showing \d+ of 8/ })).toBeVisible();

    const stateRow = async (host: string, label: string): Promise<void> => {
      const row = page.getByRole("row").filter({ hasText: host });
      await expect(row.getByText(label, { exact: true }).first()).toBeVisible();
    };
    await stateRow(FIXTURE.hostAlpha, "Fresh");
    await stateRow(FIXTURE.hostBravo, "Stale");
    await stateRow(FIXTURE.hostCharlie, "Partial");
    await stateRow(FIXTURE.hostDelta, "Unreachable");
    await stateRow(FIXTURE.hostEcho, "Never collected");

    // Undeclared observed-only host is present and marked; its intent cells say Not declared.
    const golf = page.getByRole("row").filter({ hasText: FIXTURE.hostGolf });
    await expect(golf.getByText("Undeclared", { exact: true })).toBeVisible();
    await expect(golf.getByText("Not declared", { exact: true }).first()).toBeVisible();

    // Hidden declared host remains visible and marked (truth view keeps hidden by default).
    const foxtrot = page.getByRole("row").filter({ hasText: FIXTURE.hostFoxtrot });
    await expect(foxtrot.getByText("Hidden", { exact: true })).toBeVisible();
  });
});

test.describe("services list distinctions", () => {
  test("duplicate names, lifecycle, observed state, undeclared, and hidden render", async ({
    page,
  }) => {
    await openList(page, "/services");
    await expect(page.getByRole("status").filter({ hasText: /Showing \d+ of 7/ })).toBeVisible();

    // The same service name appears on two different hosts as two independent rows.
    const alphaWeb = page
      .getByRole("row")
      .filter({ hasText: FIXTURE.hostAlpha })
      .filter({ hasText: "Alpha web service" });
    const bravoWeb = page
      .getByRole("row")
      .filter({ hasText: FIXTURE.hostBravo })
      .filter({ hasText: "Bravo web service" });
    await expect(alphaWeb).toHaveCount(1);
    await expect(bravoWeb).toHaveCount(1);
    await expect(alphaWeb.getByText("Active", { exact: true })).toBeVisible();
    await expect(alphaWeb.getByText("Running", { exact: true })).toBeVisible();

    // Declared-but-unobserved service reports Not observed under an available snapshot.
    const dbRow = page.getByRole("row").filter({ hasText: "Alpha database" });
    await expect(dbRow.getByText("Unspecified", { exact: true })).toBeVisible();
    await expect(dbRow.getByText("Not observed", { exact: true })).toBeVisible();

    // Observed-only service is undeclared and marked; declared side says Not declared.
    const ghost = page.getByRole("row").filter({ hasText: FIXTURE.serviceGhost });
    await expect(ghost.getByText("Undeclared", { exact: true })).toBeVisible();
    await expect(ghost.getByText("Degraded", { exact: true })).toBeVisible();

    // Hidden declared service remains visible and marked.
    const cache = page.getByRole("row").filter({ hasText: FIXTURE.serviceCache });
    await expect(cache.getByText("Hidden", { exact: true })).toBeVisible();
  });
});

test.describe("host detail fields", () => {
  test("the rich host renders every named section and field", async ({ page }) => {
    await page.goto(`/hosts/${enc(FIXTURE.hostAlpha)}`);
    const detail = page.getByRole("heading", { name: `Host: ${FIXTURE.hostAlpha}`, level: 1 });
    await expect(detail).toBeVisible();

    for (const section of [
      "Identity",
      "Freshness",
      "Addresses",
      "Access",
      "Backup",
      "Managed configs",
      "Secrets",
      "Links",
      "Observed facts",
      "Services on this host",
    ]) {
      await expect(page.getByRole("heading", { name: section, level: 2 })).toBeVisible();
    }

    // Identity: declared kind/purpose and the guest pair.
    await expect(page.getByText("Hypervisor")).toBeVisible();
    await expect(page.getByText("Guest vmid")).toBeVisible();
    // Freshness: inherited host collection chip.
    await expect(page.getByText("Fresh").first()).toBeVisible();
    // Addresses: matched, declared-only, and observed-only networks (row headers).
    await expect(page.getByRole("rowheader", { name: "lan", exact: true })).toBeVisible();
    await expect(page.getByRole("rowheader", { name: "mgmt", exact: true })).toBeVisible();
    await expect(page.getByRole("rowheader", { name: "vpn", exact: true })).toBeVisible();
    // Access + backup fields.
    await expect(page.getByText("Expected reachable")).toBeVisible();
    await expect(page.getByText("Nightly 02:00")).toBeVisible();
    // Managed configs sync markers (icon plus text).
    await expect(page.getByText("In sync")).toBeVisible();
    await expect(page.getByText("Out of sync")).toBeVisible();
    // Secret ids render literally; no secret values exist to leak.
    for (const secretId of FIXTURE.secretIds.slice(0, 2)) {
      await expect(page.getByText(secretId, { exact: true })).toBeVisible();
    }
    // Observed facts: zero uptime is rendered, plus containers/guests/facts.
    await expect(page.getByText("Uptime: 0 seconds")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Containers", level: 4 })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Guests", level: 4 })).toBeVisible();
    await expect(page.getByText(FIXTURE.observedFactValue)).toBeVisible();

    // No forbidden secret value appears anywhere in the normal rendered output.
    await expect(page.locator("body")).not.toContainText(FIXTURE.forbiddenSecretValue);
  });

  test("the partial host shows collector outcomes with escaped reasons", async ({ page }) => {
    await page.goto(`/hosts/${enc(FIXTURE.hostCharlie)}`);
    await expect(
      page.getByRole("heading", { name: `Host: ${FIXTURE.hostCharlie}`, level: 1 }),
    ).toBeVisible();
    await expect(page.getByText("Partial").first()).toBeVisible();
    await expect(page.getByRole("heading", { name: "Collectors succeeded" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Collectors failed" })).toBeVisible();
    await expect(page.getByText("docker: Docker socket timeout")).toBeVisible();
  });

  test("an observed-only host renders detail rather than not-found", async ({ page }) => {
    await page.goto(`/hosts/${enc(FIXTURE.hostGolf)}`);
    await expect(
      page.getByRole("heading", { name: `Host: ${FIXTURE.hostGolf}`, level: 1 }),
    ).toBeVisible();
    await expect(page.getByText("Undeclared").first()).toBeVisible();
    await expect(page.getByRole("heading", { name: "Host not found" })).toHaveCount(0);
  });
});

test.describe("service detail fields", () => {
  test("the rich service renders every named section and field", async ({ page }) => {
    await page.goto(`/services/${enc(FIXTURE.hostAlpha)}/${enc(FIXTURE.serviceWeb)}`);
    await expect(
      page.getByRole("heading", { name: `Service: ${FIXTURE.serviceWeb}`, level: 1 }),
    ).toBeVisible();

    for (const section of ["Identity", "Freshness", "Observed state", "Backup", "Secrets", "Links"]) {
      await expect(page.getByRole("heading", { name: section, level: 2 })).toBeVisible();
    }
    // Encoded host link back to the host route.
    await expect(
      page.getByRole("link", { name: FIXTURE.hostAlpha }).first(),
    ).toHaveAttribute("href", `/hosts/${enc(FIXTURE.hostAlpha)}`);
    // Declared lifecycle, inherited freshness, and observed state.
    await expect(page.getByText("Active").first()).toBeVisible();
    await expect(page.getByText("Fresh").first()).toBeVisible();
    await expect(page.getByText("Running").first()).toBeVisible();
    // Secret id renders; no forbidden value leaks.
    await expect(page.getByText("fixture-secret-web", { exact: true })).toBeVisible();
    await expect(page.locator("body")).not.toContainText(FIXTURE.forbiddenSecretValue);
  });

  test("a declared-only service reports Not observed under an available snapshot", async ({
    page,
  }) => {
    await page.goto(`/services/${enc(FIXTURE.hostAlpha)}/${enc(FIXTURE.serviceDb)}`);
    await expect(
      page.getByRole("heading", { name: `Service: ${FIXTURE.serviceDb}`, level: 1 }),
    ).toBeVisible();
    await expect(page.getByText("Not observed").first()).toBeVisible();
  });
});

test.describe("unknown routes and recovery", () => {
  test("unknown host and service routes render feature not-found with recovery links", async ({
    page,
  }) => {
    await page.goto(`/hosts/${enc("fixture-host-does-not-exist")}`);
    await expect(page.getByRole("heading", { name: "Host not found" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Back to hosts" })).toHaveAttribute(
      "href",
      "/hosts",
    );

    await page.goto(`/services/${enc("nope")}/${enc("missing")}`);
    await expect(page.getByRole("heading", { name: "Service not found" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Back to services" })).toHaveAttribute(
      "href",
      "/services",
    );
  });
});

test.describe("no-data client states (read-only interception)", () => {
  const freshness = (state: string) =>
    Object.freeze({ state, observedAt: null, ageMs: null, ttlMs: null });

  test("route-level 404 renders the no-snapshot-configured status; intent remains", async ({
    page,
  }) => {
    await page.route("**/api/providers/snapshot", (route) =>
      route.fulfill({ status: 404, contentType: "application/json", body: "{}" }),
    );
    await page.goto("/hosts");
    await expect(page.getByRole("heading", { name: "No snapshot configured" })).toBeVisible();
    await expect(page.getByText("Set DECK_SNAPSHOT_SOURCE to add observed reality.")).toBeVisible();
    // Declared intent survives with no reality.
    const alpha = page.getByRole("row").filter({ hasText: FIXTURE.hostAlpha });
    await expect(alpha.getByText("No snapshot").first()).toBeVisible();
  });

  test("a pending envelope renders the pending status", async ({ page }) => {
    await page.route("**/api/providers/snapshot", (route) =>
      route.fulfill({
        json: {
          id: "snapshot",
          kind: "snapshot",
          freshness: freshness("pending"),
          data: null,
          error: null,
        },
      }),
    );
    await page.goto("/services");
    await expect(page.getByRole("heading", { name: "Snapshot pending" })).toBeVisible();
    await expect(page.getByText("Awaiting the first snapshot poll.")).toBeVisible();
  });

  test("a failed-empty envelope renders the unavailable alert", async ({ page }) => {
    await page.route("**/api/providers/snapshot", (route) =>
      route.fulfill({
        json: {
          id: "snapshot",
          kind: "snapshot",
          freshness: freshness("unreachable"),
          data: null,
          error: { code: "POLL_TIMEOUT", message: "Snapshot read failed." },
        },
      }),
    );
    await page.goto("/hosts");
    // The unavailable heading carries role="alert", not heading.
    await expect(page.getByRole("alert").filter({ hasText: "Snapshot unavailable" })).toBeVisible();
    await expect(page.getByText("No successful snapshot has been read.")).toBeVisible();
  });

  test("a non-404 error on the first poll retains the pending placeholder", async ({ page }) => {
    await page.route("**/api/providers/snapshot", (route) =>
      route.fulfill({ status: 500, contentType: "application/json", body: "{}" }),
    );
    await page.goto("/hosts");
    // The shared inventory store keeps request/decode failures out of the
    // committed snapshot state: with no accepted generation yet, the page shows
    // the pending placeholder rather than a fabricated failure status.
    await expect(page.getByRole("heading", { name: "Snapshot pending" })).toBeVisible();
    await expect(page.getByText("Awaiting the first snapshot poll.")).toBeVisible();
  });

  test("a retained read error keeps data visible with the retained alert", async ({ page }) => {
    const now = new Date().toISOString();
    await page.route("**/api/providers/snapshot", (route) =>
      route.fulfill({
        json: {
          id: "snapshot",
          kind: "snapshot",
          freshness: { state: "stale", observedAt: now, ageMs: 1000, ttlMs: 60000 },
          data: {
            snapshot: { schemaVersion: 1, generatedAt: now, hosts: [], services: [] },
            findings: [],
            hostStates: {},
            lastReadAt: now,
            readError: { code: "POLL_TIMEOUT", message: "Snapshot read failed." },
          },
          error: null,
        },
      }),
    );
    await page.goto("/hosts");
    await expect(page.getByRole("heading", { name: "Snapshot available" })).toBeVisible();
    await expect(
      page.getByText("Latest snapshot read failed; showing the last successful snapshot."),
    ).toBeVisible();
    // Declared intent still renders alongside the retained failure.
    await expect(
      page.getByRole("row").filter({ hasText: FIXTURE.hostAlpha }).first(),
    ).toBeVisible();
  });
});

test.describe("fragment slots", () => {
  test("renders Findings then Configs slots in order, each hosting its feature fragment", async ({
    page,
  }) => {
    await page.goto(`/hosts/${enc(FIXTURE.hostAlpha)}`);
    await expect(
      page.getByRole("heading", { name: `Host: ${FIXTURE.hostAlpha}`, level: 1 }),
    ).toBeVisible();

    const slots = page.locator("[data-entity-slot]");
    await expect(slots).toHaveCount(2);
    await expect(slots.nth(0)).toHaveAttribute("data-entity-slot", "findings");
    await expect(slots.nth(1)).toHaveAttribute("data-entity-slot", "configs");
    await expect(page.getByRole("heading", { name: "Findings", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Configs", exact: true })).toBeVisible();

    // The drift-and-coverage feature registers a host findings fragment, so the
    // findings slot is no longer empty: it hosts the drift fragment instead of the
    // empty-slot placeholder.
    const findings = page.locator('[data-entity-slot="findings"]');
    await expect(
      findings.getByRole("heading", { name: `Drift findings for host ${FIXTURE.hostAlpha}` }),
    ).toBeVisible();
    await expect(findings.getByText("Nothing is attached to this slot.")).toHaveCount(0);

    // The sources-docs-and-configs feature registers the owned-configs fragment into the
    // configs slot, so it too is no longer empty. The fixture estate declares no owned
    // sources, so the fragment renders its OWN accessible empty state (distinct from the
    // slot's "nothing attached" placeholder, which no longer shows).
    const configs = page.locator('[data-entity-slot="configs"]');
    await expect(configs.getByText("Nothing is attached to this slot.")).toHaveCount(0);
    await expect(
      configs.getByText("No config files are owned by this entity."),
    ).toBeVisible();
  });

  test("synthetic fragments render for host and service references in slot order", async ({
    page,
  }) => {
    await openList(page, "/hosts");
    // Inject synthetic fragments into the live singleton registry (dev module graph).
    // Each returns text encoding the exact frozen EntityRef it received.
    await page.evaluate(async () => {
      // Resolve through a variable so tsc treats it as a dynamic (any) import; Vite
      // serves the singleton registry module at this dev URL.
      const registryUrl = "/src/registry/registry.ts";
      const reg = (await import(/* @vite-ignore */ registryUrl)) as {
        registerEntityFragment: (r: unknown) => void;
      };
      const make =
        (tag: string) =>
        (props: { entity: { entity: string; host: string; name?: string } }) =>
          `${tag}|${props.entity.entity}|${props.entity.host}|${props.entity.name ?? ""}`;
      reg.registerEntityFragment({ id: "e2e-host-find", entity: "host", slot: "findings", component: make("E2EHFIND") });
      reg.registerEntityFragment({ id: "e2e-host-conf", entity: "host", slot: "configs", component: make("E2EHCONF") });
      reg.registerEntityFragment({ id: "e2e-svc-find", entity: "service", slot: "findings", component: make("E2ESFIND") });
      reg.registerEntityFragment({ id: "e2e-svc-conf", entity: "service", slot: "configs", component: make("E2ESCONF") });
    });

    // Client-side navigation (no reload) keeps the registration and renders host slots.
    await page
      .getByRole("rowheader")
      .getByRole("link", { name: FIXTURE.hostAlpha, exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: `Host: ${FIXTURE.hostAlpha}`, level: 1 }),
    ).toBeVisible();
    await expect(
      page.locator('[data-entity-slot="findings"]'),
    ).toContainText(`E2EHFIND|host|${FIXTURE.hostAlpha}|`);
    await expect(
      page.locator('[data-entity-slot="configs"]'),
    ).toContainText(`E2EHCONF|host|${FIXTURE.hostAlpha}|`);

    // Navigate on to a service detail; the exact service reference reaches its fragments.
    await page.getByRole("link", { name: FIXTURE.serviceWeb, exact: true }).first().click();
    await expect(
      page.getByRole("heading", { name: `Service: ${FIXTURE.serviceWeb}`, level: 1 }),
    ).toBeVisible();
    await expect(
      page.locator('[data-entity-slot="findings"]'),
    ).toContainText(`E2ESFIND|service|${FIXTURE.hostAlpha}|${FIXTURE.serviceWeb}`);
    await expect(
      page.locator('[data-entity-slot="configs"]'),
    ).toContainText(`E2ESCONF|service|${FIXTURE.hostAlpha}|${FIXTURE.serviceWeb}`);
  });
});

/**
 * Keyboard-only operation of both lists (REQ-SEARCH-01, REQ-A11Y-02).
 *
 * These prove the real focus/routing behaviour the pure `keyboard.ts` reducer
 * and mounted Vitest cases can only approximate: `/`, Ctrl-K, Escape, arrows,
 * j/k, Home/End, gg/G, Enter row opening, filter composition, focus recovery,
 * and ordinary Tab/Shift-Tab with no trap — all without a mouse.
 */
for (const list of LIST_CASES) {
  test.describe(`keyboard-only operation — ${list.label}`, () => {
    test("search focus, filtering, clearing, and Ctrl-K without a mouse", async ({
      page,
    }) => {
      await openList(page, list.path);
      const search = page.getByRole("searchbox", { name: list.searchName });
      const count = page.getByRole("status").filter({ hasText: /Showing/ });
      await expect(count).toHaveText(
        new RegExp(`Showing ${list.total} of ${list.total}; 0 hidden by filters\\.`),
      );

      // `/` from the document body focuses the search input and is not typed.
      await page.keyboard.press("/");
      await expect(search).toBeFocused();
      await expect(search).toHaveValue("");

      // Typing filters the visible projection and updates the polite count.
      await page.keyboard.type(list.query);
      await expect(search).toHaveValue(list.query);
      await expect(count).toHaveText(
        new RegExp(
          `Showing ${list.queryVisible} of ${list.total}; ${
            list.total - list.queryVisible
          } hidden by filters\\.`,
        ),
      );

      // Escape clears the query and returns focus to a row link (no search trap).
      await page.keyboard.press("Escape");
      await expect(search).toHaveValue("");
      await expect(count).toHaveText(
        new RegExp(`Showing ${list.total} of ${list.total}; 0 hidden by filters\\.`),
      );
      await expect(page.locator("[data-row-link]:focus")).toHaveCount(1);

      // Ctrl-K re-focuses search from anywhere.
      await page.keyboard.press("Control+k");
      await expect(search).toBeFocused();
    });

    test("row movement and Enter open the focused row without a mouse", async ({
      page,
    }) => {
      await openList(page, list.path);
      const links = page.locator("[data-row-link]");
      const last = list.total - 1;

      // Home anchors focus deterministically at the first visible row.
      await page.keyboard.press("Home");
      await expect(links.nth(0)).toBeFocused();
      // ArrowDown / j advance; ArrowUp / k retreat, clamped and never wrapping.
      await page.keyboard.press("ArrowDown");
      await expect(links.nth(1)).toBeFocused();
      await page.keyboard.press("j");
      await expect(links.nth(2)).toBeFocused();
      await page.keyboard.press("k");
      await expect(links.nth(1)).toBeFocused();
      await page.keyboard.press("ArrowUp");
      await expect(links.nth(0)).toBeFocused();
      // End / G jump to the last row; Home / gg jump back to the first.
      await page.keyboard.press("End");
      await expect(links.nth(last)).toBeFocused();
      await page.keyboard.press("Home");
      await expect(links.nth(0)).toBeFocused();
      await page.keyboard.press("G");
      await expect(links.nth(last)).toBeFocused();
      await page.keyboard.press("g");
      await page.keyboard.press("g");
      await expect(links.nth(0)).toBeFocused();

      // Enter opens the focused row's detail route.
      await page.keyboard.press("Enter");
      await expect(
        page.getByRole("heading", { name: list.firstDetailHeading, level: 1 }),
      ).toBeVisible();
    });

    test("filters compose, recover row focus, and never trap Tab", async ({ page }) => {
      await openList(page, list.path);
      const search = page.getByRole("searchbox", { name: list.searchName });
      const links = page.locator("[data-row-link]");
      const count = page.getByRole("status").filter({ hasText: /Showing/ });
      const last = list.total - 1;

      // Focus the last row, then toggle exclude-hidden without moving focus (a
      // synthetic click): the focused row itself disappears.
      await page.keyboard.press("End");
      await expect(links.nth(last)).toBeFocused();
      const exclude = page.getByRole("checkbox", { name: list.excludeName });
      await exclude.dispatchEvent("click");
      await expect(exclude).toBeChecked();
      await expect(count).toHaveText(
        new RegExp(
          `Showing ${list.excludeVisible} of ${list.total}; ${
            list.total - list.excludeVisible
          } hidden by filters\\.`,
        ),
      );
      // The now-invalid focused row reconciles back onto a visible row link.
      await expect(page.locator("[data-row-link]:focus")).toHaveCount(1);

      // Operating the control by keyboard keeps focus on it: focus moved there
      // on purpose, so row recovery stands aside.
      await exclude.dispatchEvent("click");
      await expect(exclude).not.toBeChecked();
      await links.nth(0).focus();
      await page.keyboard.press("End");
      await expect(links.nth(last)).toBeFocused();
      await exclude.focus();
      await page.keyboard.press("Space");
      await expect(exclude).toBeChecked();
      await expect(exclude).toBeFocused();

      // Ordinary Tab from a focused row is not consumed by the row handler.
      await links.nth(1).focus();
      await page.keyboard.press("Home");
      await expect(links.nth(0)).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(links.nth(0)).not.toBeFocused();

      // Tab/Shift-Tab move between the search box and its adjacent controls.
      await search.focus();
      await page.keyboard.press("Tab");
      await expect(page.getByRole("button", { name: list.filterFacets[0], exact: true })).toBeFocused();
      await page.keyboard.press("Shift+Tab");
      await expect(search).toBeFocused();
    });
  });
}

/**
 * Semantic structure and icon-plus-text for every rendered state (REQ-A11Y-01/02).
 */
for (const list of LIST_CASES) {
  test.describe(`accessibility semantics — ${list.label}`, () => {
    test("landmarks, headings, table semantics, and labelled controls", async ({
      page,
    }) => {
      await openList(page, list.path);

      // Shell landmarks and the page/status headings.
      await expect(page.getByRole("banner")).toBeVisible();
      await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
      await expect(page.getByRole("main")).toBeVisible();
      await expect(page.getByRole("search")).toBeVisible();
      await expect(
        page.getByRole("heading", { level: 1, name: list.label }),
      ).toBeVisible();
      await expect(
        page.getByRole("heading", { level: 2, name: "Snapshot available" }),
      ).toBeVisible();

      // The table exposes its caption as an accessible name, plus every leaf column.
      const table = page.getByRole("table", { name: list.captionPattern });
      await expect(table).toBeVisible();
      for (const column of list.columns) {
        await expect(
          table.getByRole("columnheader", { name: column, exact: true }),
        ).toBeVisible();
      }
      // Entity names are semantic row headers.
      await expect(
        table.getByRole("rowheader").filter({ hasText: list.rowHeaderText }),
      ).toHaveCount(1);

      // Labelled search, one facet control per filter dimension, and the
      // exclude-hidden checkbox.
      await expect(
        page.getByRole("searchbox", { name: list.searchName }),
      ).toBeVisible();
      for (const facet of list.filterFacets) {
        await expect(page.getByRole("button", { name: facet, exact: true })).toBeVisible();
      }
      await expect(
        page.getByRole("checkbox", { name: list.excludeName }),
      ).toBeVisible();

      // The visible/total/hidden count is a polite live region.
      await expect(
        page.getByRole("status").filter({ hasText: /Showing/ }),
      ).toBeVisible();
    });

    test("every rendered state carries a decorative icon and visible text", async ({
      page,
    }) => {
      await openList(page, list.path);
      const states = await page.evaluate(() => {
        // Every status badge (states, lifecycles, markers, freshness) and the
        // snapshot status callout.
        const nodes = Array.from(
          document.querySelectorAll(
            'main [data-slot="status-badge"], main [data-slot="snapshot-status"] [data-slot="callout"]',
          ),
        );
        return nodes.map((node) => {
          const icon = node.querySelector(":scope > svg");
          return {
            selector: node.getAttribute("data-marker") ?? node.getAttribute("data-slot") ?? "",
            text: (node.textContent ?? "").trim(),
            icon: icon === null ? null : "svg",
            iconHidden: icon?.getAttribute("aria-hidden") === "true",
          };
        });
      });

      expect(states.length).toBeGreaterThan(0);
      for (const state of states) {
        expect(state.icon, `icon token present on ${state.selector}`).toBeTruthy();
        expect(state.iconHidden, `icon decorative on ${state.selector}`).toBe(true);
        expect(
          state.text.length,
          `visible text present on ${state.selector}`,
        ).toBeGreaterThan(0);
      }
    });
  });
}

/**
 * Computed colour contrast for both shell themes (REQ-A11Y-01/02).
 *
 * The exhaustive both-theme token matrix is owned by the Vitest
 * `tokens-contrast.test.ts`; here Chromium confirms the design tokens are
 * wired through to real computed styles and meet the WCAG AA thresholds.
 */
test.describe("computed contrast", () => {
  for (const list of LIST_CASES) {
    test(`state tokens and focus meet WCAG AA on ${list.label}`, async ({ page }) => {
      await openList(page, list.path);

      for (const mode of ["light", "dark"] as const) {
        const sample = await page.evaluate((themeMode) => {
          // `.dark` on <html> selects the dark design tokens (theme.css).
          document.documentElement.classList.toggle("dark", themeMode === "dark");
          const root = getComputedStyle(document.documentElement);
          // Tokens are authored in OKLCH; paint each through a canvas to get the
          // sRGB `rgb()` the contrast helper parses.
          const ctx = document.createElement("canvas").getContext("2d")!;
          const toRgb = (color: string): string => {
            ctx.clearRect(0, 0, 1, 1);
            ctx.fillStyle = color;
            ctx.fillRect(0, 0, 1, 1);
            const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
            return `rgb(${r}, ${g}, ${b})`;
          };
          const read = (name: string): string => toRgb(root.getPropertyValue(name).trim());
          const tokens = ["ok", "warn", "danger", "info", "pending", "neutral"].map((tone) =>
            read(`--status-${tone}-fg`),
          );
          const chips = Array.from(
            document.querySelectorAll('main [data-slot="status-badge"]'),
          ).map((chip) => toRgb(getComputedStyle(chip).color));
          return {
            surface: read("--card"),
            focus: read("--ring"),
            text: read("--foreground"),
            tokens,
            chips,
          };
        }, mode);

        // Body text and every closed-state colour token clear 4.5:1 on the surface.
        expect(contrastRatio(sample.text, sample.surface)).toBeGreaterThanOrEqual(4.5);
        for (const token of sample.tokens) {
          expect(contrastRatio(token, sample.surface)).toBeGreaterThanOrEqual(4.5);
        }
        // Real rendered chip colours (the wired computed styles) also clear 4.5:1.
        expect(sample.chips.length).toBeGreaterThan(0);
        for (const chip of sample.chips) {
          expect(contrastRatio(chip, sample.surface)).toBeGreaterThanOrEqual(4.5);
        }
        // Focus indication clears the 3:1 non-text threshold.
        expect(contrastRatio(sample.focus, sample.surface)).toBeGreaterThanOrEqual(3);
      }
    });
  }
});

/**
 * Security sentinel scans (REQ-SEC-01…04).
 *
 * No forbidden secret value and no runtime source-path sentinel may appear in
 * rendered text, the serialized DOM, the JSON the browser receives, or page
 * diagnostics. Binary screenshot/trace artifacts only exist on retry and carry
 * the same content proven absent from the DOM/API scans below.
 */
test.describe("security sentinel scans", () => {
  test("rendered text, DOM, and API metadata expose no secret value or source path", async ({
    page,
    request,
  }) => {
    const rootDir = process.env[INVENTORY_E2E_RUNTIME_ENV];
    expect(rootDir, "runtime root env is published before workers fork").toBeTruthy();
    const runtime = await attachMutableInventoryRuntime(rootDir!);
    const sentinels = [
      FIXTURE.forbiddenSecretValue,
      runtime.rootDir,
      runtime.configDir,
      runtime.snapshotPath,
    ];

    const diagnostics: string[] = [];
    page.on("pageerror", (error) => diagnostics.push(String(error)));
    page.on("console", (message) => {
      if (message.type() === "error") diagnostics.push(message.text());
    });

    const routes = [
      "/hosts",
      "/services",
      `/hosts/${enc(FIXTURE.hostAlpha)}`,
      `/services/${enc(FIXTURE.hostAlpha)}/${enc(FIXTURE.serviceWeb)}`,
    ];
    for (const route of routes) {
      await page.goto(route);
      await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
      const innerText = await page.evaluate(() => document.body.innerText);
      const serializedDom = await page.content();
      for (const sentinel of sentinels) {
        expect(innerText, `innerText of ${route}`).not.toContain(sentinel);
        expect(serializedDom, `serialized DOM of ${route}`).not.toContain(sentinel);
      }
    }

    // The JSON the browser actually receives is the "available metadata" surface.
    for (const endpoint of ["/api/config", "/api/providers/snapshot"]) {
      const response = await request.get(endpoint);
      expect(response.status()).toBe(200);
      const body = await response.text();
      for (const sentinel of sentinels) {
        expect(body, `response body of ${endpoint}`).not.toContain(sentinel);
      }
    }

    // No page diagnostic leaked a sentinel either.
    for (const line of diagnostics) {
      for (const sentinel of sentinels) {
        expect(line, "page diagnostics").not.toContain(sentinel);
      }
    }
  });
});

/**
 * Live mutable-source refresh and recovery (REQ-CONC-01/02, REQ-PERF-04, SC-15).
 *
 * These scenarios mutate the single ephemeral snapshot file the real Bun API
 * serves and prove the already-loaded page reflects each complete generation
 * without navigation or reload. The observable window is bounded by the composed
 * server + client polling budget: a 60-second provider interval plus a 30-second
 * browser interval plus a 5-second scheduling margin = 95 seconds (the config's
 * `expect.timeout`); exceeding it is a failure, not a skip.
 *
 * The API helper alone prepared this runtime and alone cleans it up; workers only
 * attach and publish under the owned root. Low-level torn-read timing and the
 * exhaustive source-reader refusal matrix are proven by server Vitest, not here.
 */
test.describe("live source refresh and recovery", () => {
  /** The composed provider(60s) + client(30s) + margin(5s) observation budget. */
  const COMPOSED_WINDOW_MS = 95_000;

  /** Host-state chip label expected for every host in the baseline generation. */
  const BASELINE_HOST_STATES: Readonly<Record<string, string>> = {
    [FIXTURE.hostAlpha]: "Fresh",
    [FIXTURE.hostBravo]: "Stale",
    [FIXTURE.hostCharlie]: "Partial",
    [FIXTURE.hostDelta]: "Unreachable",
    [FIXTURE.hostEcho]: "Never collected",
  };

  let runtime!: MutableInventoryRuntime;

  test.beforeAll(async () => {
    const rootDir = process.env[INVENTORY_E2E_RUNTIME_ENV];
    expect(rootDir, "runtime root env is published before workers fork").toBeTruthy();
    runtime = await attachMutableInventoryRuntime(rootDir!);
  });

  /**
   * One complete, valid generation differing only in host bravo's collection age:
   * `fresh` collects bravo at `now` (chip "Fresh"); otherwise bravo stays 25h old
   * (chip "Stale"). Every other host keeps its baseline state, so the generation
   * is internally consistent and any observed mix of old and new rows is visible.
   */
  function bravoGeneration(fresh: boolean): SnapshotDocument {
    const { snapshot } = buildInventoryScenario(Date.now());
    if (fresh) {
      const nowIso = new Date().toISOString();
      snapshot.hosts = (snapshot.hosts ?? []).map((host) =>
        host.name === FIXTURE.hostBravo ? { ...host, collectedAt: nowIso } : host,
      );
    }
    return snapshot;
  }

  /** Assert a single host row exposes exactly the given chip label (waits up to the window). */
  async function expectHostState(page: Page, host: string, label: string): Promise<void> {
    const row = page.getByRole("row").filter({ hasText: host });
    await expect(row.getByText(label, { exact: true }).first()).toBeVisible({
      timeout: COMPOSED_WINDOW_MS,
    });
  }

  /** Assert the full baseline host-state set is present as one internally consistent generation. */
  async function expectBaselineHostStates(page: Page): Promise<void> {
    for (const [host, label] of Object.entries(BASELINE_HOST_STATES)) {
      await expectHostState(page, host, label);
    }
  }

  test("runtime attach is read-only and every mutation stays under the owned root", async () => {
    const rootDir = process.env[INVENTORY_E2E_RUNTIME_ENV]!;
    // Attach resolves the same absolute root the API prepared and never owns cleanup.
    expect(runtime.rootDir).toBe(rootDir);
    expect("cleanup" in runtime, "worker attach handle exposes no cleanup").toBe(false);
    // Attach did not recreate or remove the prepared data.
    expect((await stat(runtime.configDir)).isDirectory()).toBe(true);
    expect((await stat(runtime.snapshotPath)).isFile()).toBe(true);
    // Every mutation target is confined to the ephemeral feature runtime.
    expect(runtime.rootDir).toContain(".tmp/inventory-e2e");
    expect(runtime.configDir.startsWith(runtime.rootDir)).toBe(true);
    expect(runtime.snapshotPath.startsWith(runtime.rootDir)).toBe(true);
  });

  test("an atomic replacement becomes visible without reload from one complete generation", async ({
    page,
  }) => {
    test.setTimeout(150_000);
    await openList(page, "/hosts");
    // Baseline: bravo is stale in the generation the API prepared.
    await expectHostState(page, FIXTURE.hostBravo, "Stale");

    // Publish a complete replacement atomically; the only change is bravo → fresh.
    await publishSnapshot(runtime, bravoGeneration(true));

    // Without any navigation or reload, the running page adopts the new generation.
    await expectHostState(page, FIXTURE.hostBravo, "Fresh");
    // The change is one complete generation: the stale label is gone and every
    // other host keeps its baseline state (no mixed rows).
    await expect(
      page.getByRole("row").filter({ hasText: FIXTURE.hostBravo }).getByText("Stale", { exact: true }),
    ).toHaveCount(0);
    await expectHostState(page, FIXTURE.hostAlpha, "Fresh");
    await expectHostState(page, FIXTURE.hostCharlie, "Partial");
    await expectHostState(page, FIXTURE.hostDelta, "Unreachable");
    await expectHostState(page, FIXTURE.hostEcho, "Never collected");
    await expect(page.getByRole("status").filter({ hasText: /Showing 8 of 8/ })).toBeVisible();
  });

  test("malformed content retains rows and the safe alert, then a valid read recovers", async ({
    page,
  }) => {
    // Two composed-window observations (alert appears, then clears): budget both.
    test.setTimeout(2 * COMPOSED_WINDOW_MS + 40_000);
    const retainedAlert = page.getByText(
      "Latest snapshot read failed; showing the last successful snapshot.",
    );

    await openList(page, "/hosts");
    await expect(retainedAlert).toHaveCount(0);

    // Publish malformed JSON: the provider refuses it and projects the last good read.
    await publishMalformedSnapshot(runtime);

    // Retained rows remain and the safe latest-read alert appears; the heading stays
    // "Snapshot available" because a prior successful snapshot is still shown.
    await expect(retainedAlert).toBeVisible({ timeout: COMPOSED_WINDOW_MS });
    await expect(page.getByRole("heading", { name: "Snapshot available" })).toBeVisible();
    await expect(
      page.getByRole("row").filter({ hasText: FIXTURE.hostAlpha }).first(),
    ).toBeVisible();
    // Host-state labels still derive from the retained collection timestamps.
    await expectHostState(page, FIXTURE.hostAlpha, "Fresh");

    // A later valid replacement clears the alert on a subsequent poll.
    await publishSnapshot(runtime, bravoGeneration(false));
    await expect(retainedAlert).toHaveCount(0, { timeout: COMPOSED_WINDOW_MS });
    await expect(page.getByRole("heading", { name: "Snapshot available" })).toBeVisible();
    await expectBaselineHostStates(page);
  });

  test("a torn write never yields mixed rows; only a complete generation is observable", async ({
    page,
  }) => {
    test.setTimeout(150_000);
    await openList(page, "/hosts");
    // Establish the observable starting generation (baseline: bravo stale).
    await expectHostState(page, FIXTURE.hostBravo, "Stale");

    // Split one complete later-valid generation into two chunks written with a pause.
    // While only the first chunk is on disk the file is truncated/invalid JSON, so the
    // provider refuses it and retains the prior complete generation — never a partial one.
    const later = Buffer.from(JSON.stringify(bravoGeneration(true)), "utf8");
    const mid = Math.floor(later.length / 2);
    await publishTornSnapshot(runtime, later.subarray(0, mid), later.subarray(mid), 1_000);

    // Once the write completes the file is a whole valid generation; the page adopts it.
    await expectHostState(page, FIXTURE.hostBravo, "Fresh");
    // The observable result is exactly one complete generation, never a mix of the old
    // and later rows: bravo is fresh while every other host holds its consistent state.
    await expect(
      page.getByRole("row").filter({ hasText: FIXTURE.hostBravo }).getByText("Stale", { exact: true }),
    ).toHaveCount(0);
    await expectHostState(page, FIXTURE.hostAlpha, "Fresh");
    await expectHostState(page, FIXTURE.hostCharlie, "Partial");
    await expectHostState(page, FIXTURE.hostDelta, "Unreachable");
    await expectHostState(page, FIXTURE.hostEcho, "Never collected");
    await expect(page.getByRole("status").filter({ hasText: /Showing 8 of 8/ })).toBeVisible();
  });
});

/**
 * Browser render-performance gates at the exact generated scale (REQ-PERF-01, SC-18).
 *
 * The fixed E2E config declares 7 hosts and 5 services; only the snapshot is
 * mutable, so `buildScaleGeneration` publishes a complete valid generation that
 * observes every declared identity plus enough invented `fixture-scale-*`
 * entities that the declared ∪ observed union the UI renders is exactly 150 host
 * rows and 300 service rows. The gate `beforeAll` waits until the real Bun API
 * actually serves that generation (150 derived host states) before any sample.
 *
 * For each sample a fresh browser context avoids HTTP cache: both `/api/config`
 * and `/api/providers/snapshot` listeners are attached before navigation, both
 * responses are awaited to completion, the runner clock starts at the later
 * completion, and the interval ends at exact DOM cardinality / the final core
 * section — so fixture generation, startup, navigation, and network transfer are
 * outside the measured render interval. Non-2xx responses, wrong cardinality, a
 * non-finite clock, or an uncaught page error fail the gate; the config's
 * retry keeps the same thresholds.
 */
test.describe("render performance gates", () => {
  /** Composed provider(60s) + client(30s) + margin(5s) readiness budget. */
  const COMPOSED_WINDOW_MS = 95_000;
  /** Exact union cardinalities the scale generation renders. */
  const SCALE_HOST_ROWS = 150;
  const SCALE_SERVICE_ROWS = 300;
  /** Per-sample assertion budget once a response has completed. */
  const RENDER_ASSERT_TIMEOUT_MS = 10_000;

  /** Three distinct invented hosts and services drawn from the scale generation. */
  const DETAIL_HOSTS = [
    "fixture-scale-host-000",
    "fixture-scale-host-001",
    "fixture-scale-host-002",
  ] as const;
  const DETAIL_SERVICES = [
    { host: "fixture-scale-host-000", name: "fixture-scale-svc-000" },
    { host: "fixture-scale-host-001", name: "fixture-scale-svc-001" },
    { host: "fixture-scale-host-002", name: "fixture-scale-svc-002" },
  ] as const;

  let runtime!: MutableInventoryRuntime;

  test.beforeAll(async () => {
    // Publishing plus the provider's next 60s poll can approach the composed window.
    test.setTimeout(COMPOSED_WINDOW_MS + 30_000);
    const rootDir = process.env[INVENTORY_E2E_RUNTIME_ENV];
    expect(rootDir, "runtime root env is published before workers fork").toBeTruthy();
    runtime = await attachMutableInventoryRuntime(rootDir!);

    const { snapshot } = buildScaleGeneration(Date.now());
    expect(snapshot.hosts?.length, "scale snapshot host count").toBe(SCALE_HOST_ROWS);
    expect(snapshot.services?.length, "scale snapshot service count").toBe(
      SCALE_SERVICE_ROWS,
    );
    await publishSnapshot(runtime, snapshot);

    // The provider re-reads the changed file on its next poll; wait until the real
    // API actually serves the scale generation (exactly 150 derived host states)
    // before measuring, so a sample never races an in-flight generation swap.
    const api = await apiRequest.newContext({ baseURL: `http://127.0.0.1:${process.env.DECK_E2E_API_PORT ?? 8788}` });
    try {
      await expect
        .poll(
          async () => {
            const response = await api.get("/api/providers/snapshot");
            if (!response.ok()) return -1;
            const body = (await response.json()) as {
              data?: { hostStates?: Record<string, unknown> } | null;
            };
            return body.data ? Object.keys(body.data.hostStates ?? {}).length : -1;
          },
          { timeout: COMPOSED_WINDOW_MS, intervals: [500, 1000, 2000] },
        )
        .toBe(SCALE_HOST_ROWS);
    } finally {
      await api.dispose();
    }
  });

  /**
   * One fresh-context list render sample: the interval spans the later of the two
   * response completions through exact visible row cardinality plus count status.
   */
  async function sampleListRender(
    context: BrowserContext,
    path: "/hosts" | "/services",
    expectedRows: number,
  ): Promise<number> {
    const page = await context.newPage();
    const pageErrors: Error[] = [];
    page.on("pageerror", (error) => pageErrors.push(error));

    const configResponse = page.waitForResponse((r) => r.url().includes("/api/config"));
    const snapshotResponse = page.waitForResponse((r) =>
      r.url().includes("/api/providers/snapshot"),
    );
    await page.goto(path);
    const [config, snapshotEnvelope] = await Promise.all([
      configResponse,
      snapshotResponse,
    ]);
    expect(config.ok(), `config response 2xx for ${path}`).toBe(true);
    expect(snapshotEnvelope.ok(), `snapshot response 2xx for ${path}`).toBe(true);
    await Promise.all([config.finished(), snapshotEnvelope.finished()]);

    const start = performance.now();
    const rows = page.locator("[data-row-link]");
    await expect(rows).toHaveCount(expectedRows, { timeout: RENDER_ASSERT_TIMEOUT_MS });
    await expect(
      page
        .getByRole("status")
        .filter({ hasText: new RegExp(`Showing ${expectedRows} of ${expectedRows}`) }),
    ).toBeVisible({ timeout: RENDER_ASSERT_TIMEOUT_MS });
    const elapsed = performance.now() - start;

    expect(Number.isFinite(start), "render clock start is finite").toBe(true);
    expect(Number.isFinite(elapsed), "render interval is finite").toBe(true);
    expect(pageErrors, `no uncaught page error on ${path}`).toHaveLength(0);
    await page.close();
    return elapsed;
  }

  /**
   * One fresh-context detail render sample: the interval spans response completion
   * through the expected heading and final core section becoming visible.
   */
  async function sampleDetailRender(
    context: BrowserContext,
    path: string,
    heading: string,
    finalSection: string,
  ): Promise<number> {
    const page = await context.newPage();
    const pageErrors: Error[] = [];
    page.on("pageerror", (error) => pageErrors.push(error));

    const configResponse = page.waitForResponse((r) => r.url().includes("/api/config"));
    const snapshotResponse = page.waitForResponse((r) =>
      r.url().includes("/api/providers/snapshot"),
    );
    await page.goto(path);
    const [config, snapshotEnvelope] = await Promise.all([
      configResponse,
      snapshotResponse,
    ]);
    expect(config.ok(), `config response 2xx for ${path}`).toBe(true);
    expect(snapshotEnvelope.ok(), `snapshot response 2xx for ${path}`).toBe(true);
    await Promise.all([config.finished(), snapshotEnvelope.finished()]);

    const start = performance.now();
    await expect(
      page.getByRole("heading", { name: heading, level: 1 }),
    ).toBeVisible({ timeout: RENDER_ASSERT_TIMEOUT_MS });
    await expect(
      page.getByRole("heading", { name: finalSection, level: 2 }),
    ).toBeVisible({ timeout: RENDER_ASSERT_TIMEOUT_MS });
    const elapsed = performance.now() - start;

    expect(Number.isFinite(start), "render clock start is finite").toBe(true);
    expect(Number.isFinite(elapsed), "render interval is finite").toBe(true);
    expect(pageErrors, `no uncaught page error on ${path}`).toHaveLength(0);
    await page.close();
    return elapsed;
  }

  test("hosts list renders exactly 150 rows under 1,000 ms across three fresh contexts", async ({
    browser,
  }) => {
    test.setTimeout(120_000);
    const samples: number[] = [];
    try {
      for (let sample = 0; sample < 3; sample++) {
        const context = await browser.newContext();
        try {
          const elapsed = await sampleListRender(context, "/hosts", SCALE_HOST_ROWS);
          samples.push(elapsed);
          expect(elapsed, `hosts list render sample ${sample}`).toBeLessThan(1000);
        } finally {
          await context.close();
        }
      }
    } finally {
      // Recorded even on failure, so CI logs show the headroom against the budget.
      console.info("inventory.e2e.render", { path: "/hosts", samples });
    }
  });

  test("services list renders exactly 300 rows under 1,000 ms across three fresh contexts", async ({
    browser,
  }) => {
    test.setTimeout(120_000);
    const samples: number[] = [];
    try {
      for (let sample = 0; sample < 3; sample++) {
        const context = await browser.newContext();
        try {
          const elapsed = await sampleListRender(context, "/services", SCALE_SERVICE_ROWS);
          samples.push(elapsed);
          expect(elapsed, `services list render sample ${sample}`).toBeLessThan(1000);
        } finally {
          await context.close();
        }
      }
    } finally {
      // Recorded even on failure, so CI logs show the headroom against the budget.
      console.info("inventory.e2e.render", { path: "/services", samples });
    }
  });

  test("host detail renders under 500 ms for three distinct hosts", async ({
    browser,
  }) => {
    test.setTimeout(120_000);
    for (const host of DETAIL_HOSTS) {
      const context = await browser.newContext();
      try {
        const elapsed = await sampleDetailRender(
          context,
          `/hosts/${enc(host)}`,
          `Host: ${host}`,
          "Services on this host",
        );
        expect(elapsed, `host detail render ${host}`).toBeLessThan(500);
      } finally {
        await context.close();
      }
    }
  });

  test("service detail renders under 500 ms for three distinct services", async ({
    browser,
  }) => {
    test.setTimeout(120_000);
    for (const service of DETAIL_SERVICES) {
      const context = await browser.newContext();
      try {
        const elapsed = await sampleDetailRender(
          context,
          `/services/${enc(service.host)}/${enc(service.name)}`,
          `Service: ${service.name}`,
          "Observed state",
        );
        expect(elapsed, `service detail render ${service.name}`).toBeLessThan(500);
      } finally {
        await context.close();
      }
    }
  });
});
