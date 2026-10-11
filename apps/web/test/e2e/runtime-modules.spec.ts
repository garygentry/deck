import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

/**
 * Runtime modules' web halves in a real browser: the page's import map resolves a module's
 * bare imports to deck's own React and `@deck/sdk`, so its hooks read deck's state; and a
 * module built for another module API shows "module incompatible" instead of crashing the
 * shell. The real `GET /api/ui` is extended with two runtime modules and their `web.js` is
 * served by the test, so the shared API fixture (and every other spec) stays as it is.
 */

// An icon with ids of its own (a gradient), so two renderings on one page must not repeat them.
const STAR =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="url(#s)" stroke-width="2"><defs><linearGradient id="s"><stop offset="0" stop-color="currentColor"/></linearGradient></defs><path d="M12 2l3 7h7l-5.5 4.5 2 7.5-6.5-4.5-6.5 4.5 2-7.5L2 9h7z"/></svg>';

/** A module's deck-module.json, as the server would serve it: the web half's manifest must match it. */
function manifestOf(id: string, title: string, deckApi: string) {
  return {
    id,
    version: "1.0.0",
    deckApi,
    contributes: {
      pages: [{ id: `page:${id}/main`, path: `/${id}`, title, component: "MainPage" }],
      extensions: [{ id: `pill:${id}/status`, kind: "pill", attachTo: { slot: "app/topbar.status", order: 90 }, component: "StatusPill" }],
    },
  };
}

/**
 * A web half as a module author writes it: plain ESM importing only bare, import-mapped
 * specifiers. `extraImport` names an extra `@deck/sdk` import (one deck may not have).
 */
function webJs(id: string, title: string, deckApi: string, extraImport = ""): string {
  const manifest = manifestOf(id, title, deckApi);
  return `
import { jsx, jsxs } from "react/jsx-runtime";
import { useState } from "react";
import { defineWebModule, Icon, PageHeader, Section, StatusBadge, useUiManifest${extraImport === "" ? "" : `, ${extraImport}`} } from "@deck/sdk";

const manifest = ${JSON.stringify(manifest)};

function MainPage() {
  // A hook of the module's own React import, and one reading the host's UI manifest: both
  // throw "Invalid hook call" unless the module shares the shell's one React.
  const [count, setCount] = useState(0);
  const ui = useUiManifest();
  const brand = ui.status === "ready" ? ui.manifest.brand.title : "…";
  return jsxs("div", { "data-slot": "${id}-page", children: [
    jsx(PageHeader, { title: ${JSON.stringify(title)} }),
    jsxs(Section, { title: "Host state", children: [
      jsx("p", { children: "Brand from the host: " + brand }),
      jsx("button", { type: "button", onClick: () => setCount((n) => n + 1), children: "Clicked " + count }),
      jsxs("p", { "data-testid": "icons", children: [jsx(Icon, { name: "${id}/star" }), jsx(Icon, { name: "${id}/star" })] }),
    ] }),
  ] });
}

function StatusPill() {
  return jsx(StatusBadge, { tone: "ok", icon: "${id}/star", label: ${JSON.stringify(`${title} ok`)} });
}

export default defineWebModule(manifest, { components: { MainPage, StatusPill } });
`;
}

/**
 * Add runtime modules to the real UI manifest and serve their web halves: `good` (compatible),
 * `skew` (its web half is for deckApi ^9) and `nope` (it imports a name `@deck/sdk` lacks).
 */
async function withRuntimeModules(page: Page): Promise<void> {
  const modules = [
    { id: "good", title: "Good module", deckApi: "^0.1", webApi: "^0.1", extraImport: "" },
    { id: "skew", title: "Skewed module", deckApi: "^0.1", webApi: "^9.0", extraImport: "" },
    { id: "nope", title: "Newer module", deckApi: "^0.1", webApi: "^0.1", extraImport: "WidgetOfTheFuture" },
  ];
  await page.route("**/api/ui", async (route) => {
    const body = (await (await route.fetch()).json()) as Record<string, unknown[]> & { icons?: Record<string, string> };
    await route.fulfill({
      json: {
        ...body,
        modules: [...body.modules!, ...modules.map(({ id }) => ({ id, version: "1.0.0", enabled: true, origin: "module", web: { script: `/modules/${id}/web.js` } }))],
        pages: [...body.pages!, ...modules.map(({ id, title }) => ({ id: `page:${id}/main`, module: id, path: `/${id}`, title, component: "MainPage" }))],
        navGroups: [...body.navGroups!, { id: "runtime", label: "Runtime" }],
        nav: [...body.nav!, ...modules.map(({ id, title }, index) => ({ id: `nav:${id}/main`, module: id, slot: "app/nav", page: `page:${id}/main`, group: "runtime", label: title, order: index }))],
        extensions: [...body.extensions!, ...modules.map(({ id }) => ({ id: `pill:${id}/status`, kind: "pill", module: id, slot: "app/topbar.status", order: 90, component: "StatusPill" }))],
        icons: { ...body.icons, ...Object.fromEntries(modules.map(({ id }) => [`${id}/star`, STAR])) },
      },
    }).catch(() => undefined);
  });
  for (const { id, title, deckApi, webApi, extraImport } of modules) {
    await page.route(`**/modules/${id}/deck-module.json`, (route) => route.fulfill({ json: manifestOf(id, title, deckApi) }));
    // Under the dev server, Vite tags a dynamic import's URL with `?import`; the server ignores it.
    await page.route(new RegExp(`/modules/${id}/web\\.js(\\?.*)?$`), (route) => route.fulfill({ contentType: "text/javascript", body: webJs(id, title, webApi, extraImport) }));
  }
}

/** Console errors and uncaught page errors, for the assertion that nothing crashed. */
function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  return errors;
}

test("the page's import map maps react, react-dom, react/jsx-runtime and @deck/sdk ahead of every module script", async ({ page }) => {
  await page.goto("/");
  const order = await page.evaluate(() => {
    const scripts = [...document.querySelectorAll('script[type="importmap"], script[type="module"], link[rel="modulepreload"]')];
    const map = document.querySelector('script[type="importmap"]');
    return { first: scripts[0] === map, imports: Object.keys((JSON.parse(map?.textContent ?? "{}") as { imports?: object }).imports ?? {}).sort() };
  });
  expect(order.imports).toEqual(["@deck/sdk", "react", "react-dom", "react/jsx-runtime"]);
  expect(order.first).toBe(true);
});

test("a compatible runtime module renders on deck's own React: its hooks read the host's state", async ({ page }) => {
  const errors = collectErrors(page);
  await withRuntimeModules(page);
  await page.goto("/good");

  await expect(page.getByRole("heading", { level: 1, name: "Good module" })).toBeVisible();
  const brand = await page.evaluate(async () => ((await (await fetch("/api/ui")).json()) as { brand: { title: string } }).brand.title);
  await expect(page.getByText(`Brand from the host: ${brand}`)).toBeVisible();
  // Its own state works too.
  await page.getByRole("button", { name: "Clicked 0" }).click();
  await expect(page.getByRole("button", { name: "Clicked 1" })).toBeVisible();
  // Its pill renders in the top bar, with its contributed icon.
  const pill = page.locator('[data-slot="health-header"]').getByText("Good module ok");
  await expect(pill).toBeVisible();
  await expect(page.locator('[data-slot="health-header"] span[data-slot="icon"] svg').first()).toBeVisible();

  expect(errors.filter((text) => /Invalid hook call|more than one copy of React/i.test(text))).toEqual([]);
  expect(errors.filter((text) => text.startsWith("pageerror"))).toEqual([]);
});

test("a runtime module built for another module API shows 'module incompatible', not a crash", async ({ page }) => {
  const errors = collectErrors(page);
  await withRuntimeModules(page);
  await page.goto("/skew");

  await expect(page.getByRole("heading", { level: 1, name: "Skewed module" })).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("Module incompatible");
  // Its pill is a tile saying so; the compatible module's pill still renders beside it.
  await expect(page.locator('[data-slot="module-problem-tile"]').getByText("skew: incompatible")).toBeVisible();
  await expect(page.locator('[data-slot="health-header"]').getByText("Good module ok")).toBeVisible();

  // The shell still works: the nav takes us to another page.
  await page.getByRole("link", { name: "Good module" }).first().click();
  await expect(page).toHaveURL(/\/good$/);
  await expect(page.getByRole("heading", { level: 1, name: "Good module" })).toBeVisible();

  expect(errors.filter((text) => text.startsWith("pageerror"))).toEqual([]);
  // The cause is in the console, once.
  expect(errors.filter((text) => text.includes('runtime module "skew" is incompatible'))).toHaveLength(1);
});

test("a runtime module importing a name @deck/sdk lacks is incompatible, not a crash", async ({ page }) => {
  const errors = collectErrors(page);
  await withRuntimeModules(page);
  await page.goto("/nope");

  await expect(page.getByRole("heading", { level: 1, name: "Newer module" })).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("Module incompatible");
  await expect(page.locator('[data-slot="module-problem-tile"]').getByText("nope: incompatible")).toBeVisible();
  expect(errors.filter((text) => text.startsWith("pageerror"))).toEqual([]);
  expect(errors.filter((text) => text.includes('runtime module "nope" is incompatible'))).toHaveLength(1);
});

test("a contributed icon rendered several times keeps every id on the page unique", async ({ page }) => {
  await withRuntimeModules(page);
  await page.goto("/good");
  await expect(page.getByTestId("icons").locator("svg")).toHaveCount(2);

  const ids = await page.evaluate(() => [...document.querySelectorAll("[id]")].map((element) => element.id));
  expect(ids.length - new Set(ids).size).toBe(0);
  const { violations } = await new AxeBuilder({ page }).include('[data-slot="good-page"]').include('[data-slot="health-header"]').analyze();
  expect(violations.filter((violation) => violation.id.startsWith("duplicate-id")).map((violation) => violation.id)).toEqual([]);
});
