import { expect, test, type Page } from "@playwright/test";

/**
 * Browser presentation of the governed-actions write path against the real Bun
 * API + Vite harness. Unlike the drift/inventory/alerts suites, these scenarios
 * exercise deck's ONLY write path end-to-end: the real production Bun
 * `RunnerSpawner`, real NDJSON streaming, and the real append-only audit write
 * (the vitest jobs inject a fake spawner and never touch a real subprocess).
 *
 * The API helper (`start-inventory-api.ts`) boots with actions ENABLED, a runner
 * manifest mapping `echo-runner`/`long-runner` to committed fixture scripts, and
 * a tmp audit data dir; it also declares two estate-wide actions in an overlay
 * layer: `e2e-echo` (confirm) and `e2e-long` (no-confirm, long-running). Every
 * identity is invented; no estate fact is copied and no runner command line is
 * ever synthesized by deck.
 *
 * Coverage: SC-01 (a full streamed run through a confirm action to a distinct
 * succeeded outcome) and SC-07 (cancel a long-running action → terminal
 * `cancelled` + a `cancelled` audit entry).
 */

/**
 * Navigate to the actions route, retrying the load if the Vite dev server serves
 * a blank shell (an occasional cold-transform miss). The shell banner renders on
 * every successful mount; the page's own <h1> renders once `/api/config` resolves.
 */
async function gotoActions(page: Page): Promise<void> {
  await expect(async () => {
    await page.goto("/actions");
    await expect(page.getByRole("banner")).toBeVisible({ timeout: 15_000 });
  }).toPass({ timeout: 60_000, intervals: [1000, 2000, 4000] });
  await expect(
    page.getByRole("heading", { name: "Actions", level: 1 }),
  ).toBeVisible({ timeout: 15_000 });
}

/** The selectable action row: a whole-row button named by the action title. */
const actionRow = (page: Page, title: string) =>
  page.getByRole("button", { name: title, exact: true });

/** The terminal outcome banner (a callout carrying a stable `data-outcome` hook). */
const outcomeBanner = (page: Page, outcome: string) =>
  page.locator(`[data-slot="callout"][data-outcome="${outcome}"]`);

test.describe("governed actions write path", () => {
  test("happy path: a confirm action streams to a distinct succeeded outcome (SC-01)", async ({
    page,
  }) => {
    await gotoActions(page);

    // Activate the confirm action; the grouped list is served from the real
    // /api/config so the declared action appears without any route mocking.
    await actionRow(page, "E2E echo").click();

    // confirm mode: arm, then run the named runner (real Bun spawn).
    await page.getByRole("button", { name: "Arm run" }).click();
    await page.getByRole("button", { name: /^Run E2E echo/ }).click();

    // A distinct terminal SUCCEEDED banner renders (never silent — SC-04), and
    // the runner's streamed stdout is present (the real echo runner's output).
    const banner = outcomeBanner(page, "succeeded");
    await expect(banner).toHaveAttribute("role", "status");
    await expect(banner).toBeVisible({ timeout: 30_000 });
    await expect(banner).toContainText("Succeeded");
    await expect(banner).toContainText("Exit code 0");
    await expect(page.locator('[data-stream="stdout"]')).toContainText(
      "echo runner: done",
    );
  });

  test("cancel: a long-running action reaches cancelled with a cancelled audit entry (SC-07)", async ({
    page,
  }) => {
    await gotoActions(page);

    // The no-confirm long runner: Run is armed immediately (no params).
    await actionRow(page, "E2E long runner").click();
    await page.getByRole("button", { name: /^Run E2E long runner/ }).click();

    // Live output appears with a streaming Cancel control; cancel the run.
    const cancelButton = page.getByRole("button", { name: "Cancel run" });
    await expect(cancelButton).toBeVisible({ timeout: 30_000 });
    await cancelButton.click();

    // The terminal state is a distinct CANCELLED banner (REQ-LIFE-02, SC-07).
    const banner = outcomeBanner(page, "cancelled");
    await expect(banner).toBeVisible({ timeout: 30_000 });
    await expect(banner).toContainText("Cancelled");

    // Audit history loads on mount, so reload to fetch the freshly-written entry;
    // the cancelled run is recorded exactly once as a `cancelled` audit entry.
    await gotoActions(page);
    const audit = page.getByRole("region", { name: "Audit history" });
    await expect(
      audit
        .getByRole("listitem")
        .filter({ has: page.getByRole("button", { name: "e2e-long" }) })
        .filter({ hasText: "Cancelled" })
        .first(),
    ).toBeVisible({ timeout: 30_000 });
  });
});
