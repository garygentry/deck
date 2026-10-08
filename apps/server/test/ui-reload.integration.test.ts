/**
 * `ui` hot reload end to end: the real server composition (`boot()`) over a real temp config
 * directory, edited on disk while it runs. Nothing restarts between reads.
 */

import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { UiManifest } from "@deck/module-sdk";
import { BOOT_ELEMENT_ID } from "@deck/contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stringify } from "yaml";

import { stopScheduler } from "../src/providers/registry.js";
import { boot, type BootHandle } from "../src/server/boot.js";
import { watchDirectory } from "../src/ui/live.js";

vi.setConfig({ testTimeout: 30_000 });

const BASE = { schemaVersion: 2, estate: { name: "lab" } };
const overlay = (ui: unknown) => ({ schemaVersion: 2, ui });

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
  stopScheduler();
  vi.unstubAllGlobals();
});

function configDir(ui: unknown): { dir: string; writeOverlay(text: unknown): void } {
  const dir = mkdtempSync(join(tmpdir(), "deck-reload-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const write = (name: string, document: unknown) =>
    writeFileSync(join(dir, name), typeof document === "string" ? document : stringify(document));
  write("00-base.yaml", BASE);
  write("10-overlay.yaml", overlay(ui));
  return { dir, writeOverlay: (document) => write("10-overlay.yaml", document) };
}

/** Boot deck on `dir` with the HTTP listener stubbed; requests go straight to its fetch handler. */
async function bootOn(dir: string, webDistDir?: string): Promise<(path: string, init?: RequestInit) => Promise<Response>> {
  let fetchHandler: ((request: Request) => Response | Promise<Response>) | undefined;
  vi.stubGlobal("Bun", {
    serve: (options: { fetch: (request: Request) => Response | Promise<Response> }) => {
      fetchHandler = options.fetch;
      return { stop: async () => undefined };
    },
  });
  process.env.DECK_LOG_LEVEL = "silent";
  const handle: BootHandle = await boot({ configDir: dir, port: 0, uiReload: { debounceMs: 50 }, ...(webDistDir === undefined ? {} : { webDistDir }) });
  cleanup.push(() => handle.stop());
  return (path, init) => Promise.resolve(fetchHandler!(new Request(`http://deck${path}`, init)));
}

async function manifest(request: (path: string) => Promise<Response>): Promise<{ ui: UiManifest; etag: string }> {
  const response = await request("/api/ui");
  return { ui: (await response.json()) as UiManifest, etag: response.headers.get("ETag")! };
}

const navIds = (ui: UiManifest) => ui.nav.map((item) => item.id);

describe("ui hot reload", () => {
  it("serves an edited overlay ui.nav without a restart", async () => {
    const cfg = configDir({ brand: { title: "Lab" } });
    const request = await bootOn(cfg.dir);
    const before = await manifest(request);
    expect(before.ui.navGroups.map((group) => group.id)).toEqual(["overview", "inventory", "health", "knowledge"]);
    expect(navIds(before.ui)).not.toContain("nav:ui/grafana");

    const nav = {
      groups: [
        { id: "inventory", label: "Machines", icon: "server" },
        { id: "lab", label: "Lab", icon: "flask-conical" },
        { id: "overview" },
      ],
      items: [{ id: "nav:ui/grafana", group: "lab", label: "Grafana", href: "https://grafana.lab.example/", icon: "chart-line" }],
    };
    cfg.writeOverlay(overlay({ brand: { title: "Lab" }, nav }));

    await vi.waitFor(async () => expect((await manifest(request)).etag).not.toBe(before.etag), { timeout: 10_000, interval: 50 });
    const after = await manifest(request);
    // The new nav, straight from the edited ui.nav: group order, labels and icons, and the link.
    expect(after.ui.navGroups.slice(0, 3)).toEqual([
      { id: "inventory", label: "Machines", icon: "server" },
      { id: "lab", label: "Lab", icon: "flask-conical" },
      { id: "overview", label: "Overview" },
    ]);
    expect(after.ui.nav.find((item) => item.id === "nav:ui/grafana")).toMatchObject({
      group: "lab",
      label: "Grafana",
      href: "https://grafana.lab.example/",
      icon: "chart-line",
    });
    expect(after.ui.findings).toEqual([]);
    // The old ETag no longer matches; the new one revalidates as 304.
    expect((await request("/api/ui", { headers: { "If-None-Match": before.etag } })).status).toBe(200);
    expect((await request("/api/ui", { headers: { "If-None-Match": after.etag } })).status).toBe(304);
    const config = (await (await request("/api/config")).json()) as { ui: { nav: unknown } };
    expect(config.ui.nav).toEqual(nav);

    // An extension override in the same subtree reloads too: a hidden entry leaves the nav.
    cfg.writeOverlay(overlay({ brand: { title: "Lab" }, nav, extensions: { "nav:inventory/services": false } }));
    await vi.waitFor(async () => expect(navIds((await manifest(request)).ui)).not.toContain("nav:inventory/services"), { timeout: 10_000, interval: 50 });
    expect(navIds((await manifest(request)).ui)).toContain("nav:ui/grafana");
  });

  it("writes the swapped brand into index.html's boot object", async () => {
    const cfg = configDir({ brand: { title: "Lab" } });
    const dist = mkdtempSync(join(tmpdir(), "deck-reload-dist-"));
    cleanup.push(() => rmSync(dist, { recursive: true, force: true }));
    writeFileSync(join(dist, "index.html"), `<html><head><title>Deck</title></head><body><script type="application/json" id="${BOOT_ELEMENT_ID}"></script></body></html>`);
    const request = await bootOn(cfg.dir, dist);
    const before = await manifest(request);
    expect(await (await request("/")).text()).toContain("<title>Lab</title>");

    cfg.writeOverlay(overlay({ brand: { title: "Gentry Lab" }, theme: { mode: "dark" } }));
    await vi.waitFor(async () => expect((await manifest(request)).etag).not.toBe(before.etag), { timeout: 10_000, interval: 50 });
    const page = await (await request("/")).text();
    expect(page).toContain("<title>Gentry Lab</title>");
    expect(page).toContain('"mode":"dark"');
  });

  it("keeps the old UI and shows a finding for an invalid edit, then recovers", async () => {
    const cfg = configDir({ brand: { title: "Lab" } });
    const request = await bootOn(cfg.dir);
    const good = await manifest(request);

    // Not YAML at all.
    cfg.writeOverlay("ui: [unclosed\n");
    await vi.waitFor(async () => expect((await manifest(request)).ui.findings.map((f) => f.code)).toEqual(["UI_CONFIG_INVALID"]), { timeout: 10_000, interval: 50 });
    const broken = await manifest(request);
    expect({ ...broken.ui, findings: [] }).toEqual(good.ui);
    expect(broken.ui.findings[0]?.message).toContain("Failed to parse 10-overlay.yaml");
    expect(broken.ui.findings[0]?.message).not.toContain(cfg.dir);

    // YAML, but a ui the schema rejects.
    cfg.writeOverlay(overlay({ brand: { title: 42 } }));
    await vi.waitFor(async () => expect((await manifest(request)).ui.findings[0]?.message).toContain("/ui/brand/title"), { timeout: 10_000, interval: 50 });
    expect((await manifest(request)).ui.brand.title).toBe("Lab");

    // A change outside ui: restart required, the old UI stays.
    writeFileSync(join(cfg.dir, "00-base.yaml"), stringify({ ...BASE, estate: { name: "renamed" } }));
    cfg.writeOverlay(overlay({ brand: { title: "Lab" } }));
    await vi.waitFor(async () => expect((await manifest(request)).ui.findings.map((f) => f.code)).toEqual(["UI_RESTART_REQUIRED"]), { timeout: 10_000, interval: 50 });
    expect((await manifest(request)).ui.findings[0]?.message).toContain("estate");

    // Reverted: the finding clears and the ETag is the booted one again.
    writeFileSync(join(cfg.dir, "00-base.yaml"), stringify(BASE));
    await vi.waitFor(async () => expect((await manifest(request)).etag).toBe(good.etag), { timeout: 10_000, interval: 50 });
  });
});

describe("config directory watch", () => {
  it("reports changes under any name, and re-arms when the directory is replaced", async () => {
    const parent = mkdtempSync(join(tmpdir(), "deck-watch-"));
    cleanup.push(() => rmSync(parent, { recursive: true, force: true }));
    const dir = join(parent, "config");
    mkdirSync(dir);
    const logger = { info: vi.fn(), warn: vi.fn() };
    const onChange = vi.fn();
    const watcher = watchDirectory(logger, 50)(dir, onChange);
    cleanup.push(() => watcher.close());

    // A ConfigMap-style swap: no YAML file name is involved.
    writeFileSync(join(dir, "..data_tmp"), "x");
    await vi.waitFor(() => expect(onChange).toHaveBeenCalled(), { timeout: 5_000, interval: 20 });

    // The directory is replaced wholesale: the watch says so, re-arms and reports a change.
    renameSync(dir, join(parent, "old"));
    mkdirSync(dir);
    onChange.mockClear();
    await vi.waitFor(() => expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({ event: "config.watch", state: "rearmed" }), expect.any(String)), { timeout: 5_000, interval: 20 });
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ event: "config.watch", state: "lost" }), expect.any(String));
    expect(onChange).toHaveBeenCalled();

    onChange.mockClear();
    writeFileSync(join(dir, "20-new.yaml"), "x: 1");
    await vi.waitFor(() => expect(onChange).toHaveBeenCalled(), { timeout: 5_000, interval: 20 });
  });
});
