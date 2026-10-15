import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { expect, test } from "@playwright/test";
import { READY_TIMEOUT_MS, startSpecApi, stopSpecApi, useSpecApi, type SpecApi } from "./spec-api.js";

/**
 * A sidecar's markdown loads nothing when the page shows it, whatever the CSP allows. A fake
 * sidecar (in this process) describes one `core/markdown` widget whose images, media and CSS
 * references (escaped, too) all point back at the sidecar itself. Deck's server polls only
 * `/deck/v1/*`, so any other request the sidecar sees came from the browser rendering the
 * markdown: there must be none.
 */

const MAIN = "main#main";

function markdown(origin: string): string {
  return [
    "Notes from the sidecar.",
    "",
    `![beacon badge](${origin}/md.png)`,
    "",
    `<img src="${origin}/raw.png" srcset="${origin}/raw2.png" alt="raw image">`,
    "",
    `<picture><source srcset="${origin}/pic.webp"><img src="${origin}/pic.png" alt="picture"></picture>`,
    "",
    `<video src="${origin}/v.mp4" poster="${origin}/poster.png">Video fallback <a href="https://ok.example/v.mp4">download</a></video>`,
    "",
    `<input type="image" src="${origin}/input.png" alt="image input">`,
    "",
    `<table background="${origin}/table.png"><tr><td>cell</td></tr></table>`,
    "",
    `<svg width="20" height="20"><rect width="20" height="20" fill="u\\72l(${origin}/fill.svg#g)" filter="url(${origin}/filter.svg#f)"></rect><image href="${origin}/svg-image.png" width="20" height="20"></image></svg>`,
    "",
    `<svg width="20" height="20"><rect width="20" height="20" mask='image-set("${origin}/mask.png" 1x)'></rect><rect width="20" height="20" mask='-webkit-image-set("${origin}/wmask.png" 1x)'></rect></svg>`,
  ].join("\n");
}

test.describe("a sidecar's markdown", () => {
  let api: SpecApi;
  let sidecar: Server;
  const fromBrowser: string[] = [];

  test.beforeAll(async () => {
    test.setTimeout(READY_TIMEOUT_MS * 2 + 30_000);
    sidecar = createServer((request, response) => {
      const path = request.url ?? "/";
      const origin = `http://127.0.0.1:${(sidecar.address() as AddressInfo).port}`;
      const reply = (body: unknown) => {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify(body));
      };
      if (path === "/deck/v1/data") return reply({ data: { ok: true } });
      if (path === "/deck/v1/describe") {
        return reply({
          deck: 1,
          id: "beacon",
          version: "1.0.0",
          title: "Beacon",
          widgets: [{ id: "notes", type: "core/markdown", title: "Notes", options: { content: markdown(origin) } }],
        });
      }
      fromBrowser.push(path);
      response.writeHead(404);
      response.end();
    });
    await new Promise<void>((resolve) => sidecar.listen(0, "127.0.0.1", resolve));
    const port = (sidecar.address() as AddressInfo).port;
    api = await startSpecApi("remote-markdown", {
      DECK_E2E_INTEGRATIONS: JSON.stringify([
        { id: "beacon", kind: "remote", title: "Beacon", url: `http://127.0.0.1:${port}`, pollIntervalMs: 2_000, ttlMs: 600_000, page: { path: "/remote/beacon" } },
      ]),
    });
  });

  test.afterAll(async () => {
    if (api !== undefined) await stopSpecApi(api);
    await new Promise((resolve) => sidecar?.close(resolve));
  });

  test("shows images as alt text and media as fallback content, and fetches nothing from the sidecar's markdown", async ({ page }) => {
    const origin = `http://127.0.0.1:${(sidecar.address() as AddressInfo).port}`;
    const pageRequests: string[] = [];
    page.on("request", (request) => {
      if (request.url().startsWith(origin)) pageRequests.push(request.url());
    });
    await useSpecApi(page, api.port);
    await page.goto("/remote/beacon");
    const prose = page.locator(`${MAIN} [data-slot="prose"]`);
    await expect(prose).toContainText("Notes from the sidecar.", { timeout: 30_000 });
    await expect(prose).toContainText("beacon badge");
    await expect(prose).toContainText("raw image");
    await expect(prose).toContainText("Video fallback");
    await expect(prose.getByRole("link", { name: /download/ })).toHaveAttribute("href", "https://ok.example/v.mp4");
    await expect(prose.locator("img, picture source, video, audio, image")).toHaveCount(0);
    await expect(prose.locator("rect")).toHaveCount(3);
    await expect(prose.locator("[mask], [fill], [filter]")).toHaveCount(0);
    // Let anything the page might have started arrive before asserting none did.
    await page.waitForLoadState("networkidle");
    expect(pageRequests).toEqual([]);
    expect(fromBrowser).toEqual([]);
  });
});
