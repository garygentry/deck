import { expect, test, type Page } from "@playwright/test";
import { seedTheme } from "./theme-seed.js";

/**
 * Visual baselines for `/actions` in its main states, independent of the `/_ui`
 * workbench. Like the workbench baselines they are generated and verified on CI
 * Linux only (font rasterisation differs across hosts): locally they are skipped
 * unless UPDATE_VISUALS is set; refresh them in CI with the `update_visuals`
 * workflow_dispatch input.
 *
 * The declared actions, the capability probe, the audit list/detail and every
 * invoke response are routed fixtures (no runner is spawned), and the browser
 * clock is fixed. The streaming state is a routed NDJSON body with no `end`
 * event, so the run stays streaming. All identities are invented.
 */

const VISUALS = Boolean(process.env.CI || process.env.UPDATE_VISUALS);
const WIDTHS = [375, 768, 1280] as const;
const THEMES = ["light", "dark"] as const;
const FROZEN_NOW = new Date("2026-01-15T12:00:00Z");

// The shell chrome is sticky (it would overlay a tall capture) and carries live
// data (the health header). Hide it, so the capture is just the page.
const HIDE_SHELL =
  'header[aria-label="Deck"], [data-slot="sidebar"] { display: none !important; }';

type JsonObject = Record<string, unknown>;

const ACTIONS: JsonObject[] = [
  {
    id: "sync-mirrors",
    title: "Sync mirrors",
    description: "Pull every package mirror from upstream.",
    runner: "sync-mirrors",
    confirm: "none",
  },
  {
    id: "rotate-logs",
    title: "Rotate logs",
    description: "Compress and rotate application logs.",
    runner: "rotate-logs",
    confirm: "confirm",
    target: { host: "app-01.example.invalid", service: "nginx" },
    params: [
      { name: "keep", type: "number", default: 7, description: "Rotated files to keep." },
      { name: "compress", type: "boolean", default: true },
    ],
  },
  {
    id: "restart-service",
    title: "Restart service",
    description: "Restart one systemd unit.",
    runner: "restart-unit",
    confirm: "typed-confirm",
    target: { host: "db-01.example.invalid" },
    params: [
      { name: "unit", type: "string", required: true, description: "The systemd unit name." },
      { name: "mode", type: "enum", values: ["graceful", "hard"], default: "graceful" },
    ],
  },
];

const AUDIT: JsonObject[] = [
  {
    runId: "run-0003",
    timestamp: "2026-01-15T11:58:00.000Z",
    actionId: "rotate-logs",
    runner: "rotate-logs",
    target: { host: "app-01.example.invalid", service: "nginx" },
    outcome: "succeeded",
    exitStatus: 0,
    durationMs: 842,
    outputBytes: 64,
  },
  {
    runId: "run-0002",
    timestamp: "2026-01-15T10:12:00.000Z",
    actionId: "restart-service",
    runner: "restart-unit",
    target: { host: "db-01.example.invalid" },
    outcome: "failed",
    exitStatus: 3,
    durationMs: 5120,
    outputBytes: 120,
  },
  {
    runId: "run-0001",
    timestamp: "2026-01-14T22:40:00.000Z",
    actionId: "sync-mirrors",
    runner: "sync-mirrors",
    outcome: "cancelled",
    exitStatus: null,
    durationMs: 30000,
    outputBytes: 12,
  },
];

const AUDIT_DETAIL: JsonObject = {
  entry: {
    ...AUDIT[0],
    params: { keep: 7, compress: true },
    source: "192.0.2.10",
  },
  output: "rotating /var/log/nginx/access.log\nrotating /var/log/nginx/error.log\ndone: 2 files rotated\n",
};

const ndjson = (events: JsonObject[]): string => events.map((e) => JSON.stringify(e)).join("\n") + "\n";

const STREAM_START: JsonObject[] = [
  { type: "run", runId: "run-0004" },
  { type: "stdout", data: "fetching mirror index…\nmirror debian: 1203 packages\n" },
];

const INVOKE = {
  streaming: ndjson(STREAM_START),
  succeeded: ndjson([
    ...STREAM_START,
    { type: "stdout", data: "mirror alpine: 412 packages\nall mirrors in sync\n" },
    { type: "end", outcome: "succeeded", exit: 0, durationMs: 4210 },
  ]),
  failed: ndjson([
    ...STREAM_START,
    { type: "stderr", data: "error: mirror alpine unreachable (timeout)\n" },
    { type: "end", outcome: "failed", exit: 3, durationMs: 15022 },
  ]),
};

interface Scenario {
  /** The capability probe result. */
  enabled: boolean;
  /** Drive the page into the state after it settles. */
  drive?: (page: Page) => Promise<void>;
  /** The routed invoke body, when the scenario runs an action. */
  invoke?: string;
}

const select = (page: Page, title: string) =>
  page.getByRole("button", { name: title, exact: true }).click();

const SCENARIOS: Record<string, Scenario> = {
  list: { enabled: true },
  "param-error": {
    enabled: true,
    drive: async (page) => {
      await select(page, "Restart service");
      await expect(page.getByRole("alert").filter({ hasText: "required" })).toBeVisible();
    },
  },
  confirm: {
    enabled: true,
    drive: async (page) => {
      await select(page, "Rotate logs");
      await expect(page.getByRole("button", { name: "Arm run" })).toBeVisible();
    },
  },
  streaming: {
    enabled: true,
    invoke: INVOKE.streaming,
    drive: async (page) => {
      await select(page, "Sync mirrors");
      await page.getByRole("button", { name: "Run Sync mirrors" }).click();
      await expect(page.getByRole("button", { name: "Cancel run" })).toBeVisible();
    },
  },
  succeeded: {
    enabled: true,
    invoke: INVOKE.succeeded,
    drive: async (page) => {
      await select(page, "Sync mirrors");
      await page.getByRole("button", { name: "Run Sync mirrors" }).click();
      await expect(page.locator('[data-outcome="succeeded"]')).toBeVisible();
    },
  },
  failed: {
    enabled: true,
    invoke: INVOKE.failed,
    drive: async (page) => {
      await select(page, "Sync mirrors");
      await page.getByRole("button", { name: "Run Sync mirrors" }).click();
      await expect(page.locator('[data-outcome="failed"]')).toBeVisible();
    },
  },
  "audit-detail": {
    enabled: true,
    drive: async (page) => {
      await page.getByRole("region", { name: "Audit history" }).getByRole("button", { name: "rotate-logs" }).click();
      await expect(page.getByRole("figure", { name: "Captured output" })).toBeVisible();
    },
  },
  disabled: { enabled: false },
};

async function routeScenario(page: Page, scenario: Scenario): Promise<void> {
  await page.route("**/api/config", async (route) => {
    const response = await route.fetch();
    const config = (await response.json()) as JsonObject;
    const modules = (config.modules ?? {}) as JsonObject;
    await route.fulfill({ json: { ...config, modules: { ...modules, actions: { actions: ACTIONS } } } });
  });
  await page.route("**/api/actions", (route) => route.fulfill({ json: { enabled: scenario.enabled } }));
  await page.route("**/api/actions/audit", (route) =>
    scenario.enabled ? route.fulfill({ json: AUDIT }) : route.fulfill({ status: 403, json: {} }),
  );
  await page.route("**/api/actions/audit/*", (route) => route.fulfill({ json: AUDIT_DETAIL }));
  await page.route("**/api/actions/sync-mirrors", (route) =>
    route.fulfill({ status: 200, contentType: "application/x-ndjson", body: scenario.invoke ?? "" }),
  );
}

test.describe("actions visual baselines", () => {
  test.skip(!VISUALS, "Visual baselines run on CI Linux only; set UPDATE_VISUALS=1 to run them");

  for (const [name, scenario] of Object.entries(SCENARIOS)) {
    for (const theme of THEMES) {
      for (const width of WIDTHS) {
        test(`${name} ${width}px ${theme}`, async ({ page }) => {
          await page.clock.setFixedTime(FROZEN_NOW);
          await seedTheme(page, theme);
          await page.setViewportSize({ width, height: 900 });
          await routeScenario(page, scenario);
          const actions = page.getByTestId("actions");
          // Retry a load that leaves the shell blank (a cold dev-server transform under load).
          await expect(async () => {
            await page.goto("/actions");
            await expect(actions.getByRole("button", { name: "Sync mirrors" }).or(actions.getByText("Sync mirrors")).first()).toBeVisible({ timeout: 15_000 });
          }).toPass({ timeout: 60_000, intervals: [1000, 2000, 4000] });
          // The audit history has settled (listed, or the disabled notice).
          await expect(
            actions.getByRole("region", { name: "Audit history" }).getByRole("listitem").first()
              .or(actions.getByText("Audit history is unavailable while the actions capability is disabled.")),
          ).toBeVisible();
          await scenario.drive?.(page);
          await page.addStyleTag({ content: HIDE_SHELL });
          await expect(page.getByRole("navigation", { name: "Primary" })).toBeHidden();
          await page.evaluate(() => document.fonts.ready);
          await expect(page).toHaveScreenshot(`actions-${name}-${width}-${theme}.png`, {
            fullPage: true,
            animations: "disabled",
            caret: "hide",
          });
        });
      }
    }
  }
});
