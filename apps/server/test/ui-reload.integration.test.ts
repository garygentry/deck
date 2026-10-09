/**
 * `ui` hot reload end to end: the real server composition (`boot()`) over a real temp config
 * directory, edited on disk while it runs. Nothing restarts between reads.
 */

import { mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FindingCodeDecl, ServerModule, UiManifest } from "@deck/module-sdk";
import { BOOT_ELEMENT_ID } from "@deck/contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stringify } from "yaml";

import { BUILTIN_MODULES } from "../src/modules/builtin.js";
import { stopScheduler } from "../src/providers/registry.js";
import { boot, type BootHandle } from "../src/server/boot.js";
import { watchDirectory } from "../src/ui/live.js";

vi.setConfig({ testTimeout: 30_000 });

/** Every line deck's boot logger writes, parsed: tests wait on them. */
const logLines: Array<Record<string, unknown>> = [];

vi.mock("../src/log/logger.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/log/logger.js")>();
  const pino = (await import("pino")).default;
  return {
    ...original,
    createLogger: () => pino({ level: "info" }, { write: (line: string) => void logLines.push(JSON.parse(line) as Record<string, unknown>) }),
  };
});

const BASE = { schemaVersion: 2, estate: { name: "lab" } };
const overlay = (ui: unknown) => ({ schemaVersion: 2, ui });

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
  logLines.length = 0;
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

type Request_ = (path: string, init?: RequestInit) => Promise<Response>;

/** Boot deck on `dir` with the HTTP listener stubbed; requests go straight to its fetch handler. */
async function bootOn(dir: string, options: { webDistDir?: string; modules?: readonly ServerModule<any>[] } = {}): Promise<Request_> {
  let fetchHandler: ((request: Request) => Response | Promise<Response>) | undefined;
  vi.stubGlobal("Bun", {
    serve: (serveOptions: { fetch: (request: Request) => Response | Promise<Response> }) => {
      fetchHandler = serveOptions.fetch;
      return { stop: async () => undefined };
    },
  });
  process.env.DECK_LOG_LEVEL = "silent";
  const handle: BootHandle = await boot({ configDir: dir, port: 0, uiReload: { debounceMs: 50 }, ...options });
  cleanup.push(() => handle.stop());
  return (path, init) => Promise.resolve(fetchHandler!(new Request(`http://deck${path}`, init)));
}

const SECRET = "canary-9b1d4e7f-not-for-the-api";

const CANARY_LEAK: FindingCodeDecl = { code: "CANARY_LEAK", severity: "error", summary: "The canary leaks.", fix: "Set leak to false." };

/**
 * A module whose config rule reports an error with an environment secret in its message, and
 * whose init waits for `ready` (so a test can edit the config while modules start).
 */
function canaryModule(ready: Promise<void> = Promise.resolve()): ServerModule<{ leak: boolean }> {
  return {
    manifest: {
      id: "canary",
      version: "1.0.0",
      deckApi: "^0.1",
      enabledBy: { config: true },
      config: {
        schema: { type: "object", additionalProperties: false, properties: { leak: { type: "boolean" } } },
        ownership: { "": "overlay" },
        findings: [CANARY_LEAK],
      },
    },
    configRules: [
      (section, { layer }) =>
        layer === "merged" && section.leak ? [{ code: CANARY_LEAK.code, path: "/leak", message: `token ${process.env.CANARY_TOKEN} leaked` }] : [],
    ],
    init: async () => {
      await ready;
    },
  };
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
    const request = await bootOn(cfg.dir, { webDistDir: dist });
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
    expect(broken.ui.findings[0]?.message).toContain("CONFIG_YAML_PARSE: a config file is not valid YAML");
    expect(broken.ui.findings[0]?.message).not.toContain(cfg.dir);

    // YAML, but a ui the schema rejects.
    cfg.writeOverlay(overlay({ brand: { title: 42 } }));
    await vi.waitFor(async () => expect((await manifest(request)).ui.findings[0]?.message).toContain("at /ui/brand/title"), { timeout: 10_000, interval: 50 });
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

describe("ui hot reload, review round 1", () => {
  const waitFor = (check: () => Promise<void>, timeout = 10_000) => vi.waitFor(check, { timeout, interval: 50 });
  const findingOf = async (request: Request_) => (await manifest(request)).ui.findings.map((f) => `${f.code}: ${f.message}`).join("\n");

  it("swaps a theme-only edit into /api/config and index.html, though the manifest is unchanged", async () => {
    const cfg = configDir({ brand: { title: "Lab" } });
    const dist = mkdtempSync(join(tmpdir(), "deck-reload-dist-"));
    cleanup.push(() => rmSync(dist, { recursive: true, force: true }));
    writeFileSync(join(dist, "index.html"), `<html><head><title>Deck</title></head><body><script type="application/json" id="${BOOT_ELEMENT_ID}"></script></body></html>`);
    const request = await bootOn(cfg.dir, { webDistDir: dist });
    const before = await manifest(request);

    cfg.writeOverlay(overlay({ brand: { title: "Lab" }, theme: { mode: "dark", preset: "rose" } }));
    await waitFor(async () => expect(((await (await request("/api/config")).json()) as { ui: { theme?: unknown } }).ui.theme).toEqual({ mode: "dark", preset: "rose" }));
    const page = await (await request("/")).text();
    expect(page).toContain('"mode":"dark"');
    expect(page).toContain('"preset":"rose"');
    expect((await manifest(request)).etag).toBe(before.etag);
  });

  it("never serves a module finding's message: a secret in it stays out of /api/ui", async () => {
    vi.stubEnv("CANARY_TOKEN", SECRET);
    cleanup.push(() => {
      vi.unstubAllEnvs();
    });
    const cfg = configDir({ brand: { title: "Lab" } });
    const request = await bootOn(cfg.dir, { modules: [...BUILTIN_MODULES, canaryModule()] });

    cfg.writeOverlay({ ...overlay({ brand: { title: "Lab" } }), modules: { canary: { leak: true } } });
    await waitFor(async () => expect(await findingOf(request)).toContain("UI_CONFIG_INVALID"));
    const text = await findingOf(request);
    expect(text).toContain("CANARY_LEAK at /modules/canary.");
    expect(text).not.toContain(SECRET);
    expect(JSON.stringify((await manifest(request)).ui)).not.toContain(SECRET);
  });

  it("sees an edit made while modules are still starting", async () => {
    const cfg = configDir({ brand: { title: "Lab" } });
    // The canary module runs (its section is present), so boot waits on its init.
    cfg.writeOverlay({ ...overlay({ brand: { title: "Lab" } }), modules: { canary: {} } });
    let release!: () => void;
    const ready = new Promise<void>((resolve) => (release = resolve));
    const booting = bootOn(cfg.dir, { modules: [...BUILTIN_MODULES, canaryModule(ready)] });
    // Boot has read the config and is waiting on the module's init: edit now, then let it start.
    await new Promise((resolve) => setTimeout(resolve, 200));
    cfg.writeOverlay({ ...overlay({ brand: { title: "Edited while starting" } }), modules: { canary: {} } });
    await new Promise((resolve) => setTimeout(resolve, 100));
    release();
    const request = await booting;

    await waitFor(async () => expect((await manifest(request)).ui.brand.title).toBe("Edited while starting"));
  });

  it("says the directory is missing or empty, naming no path, and clears once it is back", async () => {
    const cfg = configDir({ brand: { title: "Lab" } });
    const request = await bootOn(cfg.dir);
    const good = await manifest(request);

    // Empty: every YAML file gone.
    const saved = readdirSync(cfg.dir);
    const moved = mkdtempSync(join(tmpdir(), "deck-reload-moved-"));
    cleanup.push(() => rmSync(moved, { recursive: true, force: true }));
    for (const name of saved) renameSync(join(cfg.dir, name), join(moved, name));
    await waitFor(async () => expect(await findingOf(request)).toContain("CONFIG_DIR_EMPTY: the config directory contains no YAML files"));
    expect(await findingOf(request)).not.toContain(cfg.dir);
    for (const name of saved) renameSync(join(moved, name), join(cfg.dir, name));
    await waitFor(async () => expect((await manifest(request)).etag).toBe(good.etag));

    // Missing: the directory deleted, then made again (often on the same inode).
    rmSync(cfg.dir, { recursive: true });
    await waitFor(async () => expect(await findingOf(request)).toContain("CONFIG_DIR_MISSING"));
    expect(await findingOf(request)).not.toContain(cfg.dir);
    mkdirSync(cfg.dir);
    writeFileSync(join(cfg.dir, "00-base.yaml"), stringify(BASE));
    writeFileSync(join(cfg.dir, "10-overlay.yaml"), stringify(overlay({ brand: { title: "Lab" } })));
    // The watch re-arms on its next check (every 5 s) and reads the directory again.
    await waitFor(async () => expect((await manifest(request)).etag).toBe(good.etag), 15_000);
    // And it watches the new directory.
    writeFileSync(join(cfg.dir, "10-overlay.yaml"), stringify(overlay({ brand: { title: "Back" } })));
    await waitFor(async () => expect((await manifest(request)).ui.brand.title).toBe("Back"));
  });

  it("follows a Kubernetes ConfigMap layout, whose ..data symlink is re-pointed atomically", async () => {
    const dir = mkdtempSync(join(tmpdir(), "deck-reload-cm-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const version = (name: string, title: string) => {
      mkdirSync(join(dir, name));
      writeFileSync(join(dir, name, "00-base.yaml"), stringify(BASE));
      writeFileSync(join(dir, name, "10-overlay.yaml"), stringify(overlay({ brand: { title } })));
    };
    version("..2026_10_08_a", "Lab");
    symlinkSync("..2026_10_08_a", join(dir, "..data"));
    for (const name of ["00-base.yaml", "10-overlay.yaml"]) symlinkSync(join("..data", name), join(dir, name));
    const request = await bootOn(dir);
    expect((await manifest(request)).ui.brand.title).toBe("Lab");
    // Let the boot-time re-read settle first, so only the watch can see the swap.
    await waitFor(async () => expect(logLines.some((line) => line.event === "config.reload" && line.result === "unchanged")).toBe(true));

    // What the kubelet does: write the new version, point ..data_tmp at it, rename it over ..data.
    version("..2026_10_08_b", "From the ConfigMap");
    symlinkSync("..2026_10_08_b", join(dir, "..data_tmp"));
    renameSync(join(dir, "..data_tmp"), join(dir, "..data"));
    rmSync(join(dir, "..2026_10_08_a"), { recursive: true });

    await waitFor(async () => expect((await manifest(request)).ui.brand.title).toBe("From the ConfigMap"));
  });
});

describe("config directory watch", () => {
  /** A ConfigMap-style directory: versioned dirs, a `..data` symlink, files linked through it. */
  function configMapDir(): { dir: string; swap(content: string): void } {
    const dir = mkdtempSync(join(tmpdir(), "deck-watch-cm-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    let n = 0;
    const version = (content: string) => {
      const name = `..v${(n += 1)}`;
      mkdirSync(join(dir, name));
      writeFileSync(join(dir, name, "10-overlay.yaml"), content);
      return name;
    };
    symlinkSync(version("a: 1"), join(dir, "..data"));
    symlinkSync(join("..data", "10-overlay.yaml"), join(dir, "10-overlay.yaml"));
    return {
      dir,
      swap(content) {
        symlinkSync(version(content), join(dir, "..data_tmp"));
        renameSync(join(dir, "..data_tmp"), join(dir, "..data"));
      },
    };
  }

  it("sees a ConfigMap swap with no file-system event at all, by the files' fingerprint", async () => {
    const cm = configMapDir();
    const logger = { info: vi.fn(), warn: vi.fn() };
    const onChange = vi.fn();
    // Events off: what Bun delivers for a re-pointed ..data symlink (nothing).
    const watcher = watchDirectory(logger, { checkMs: 50, events: false })(cm.dir, onChange);
    cleanup.push(() => watcher.close());

    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(onChange).not.toHaveBeenCalled();
    cm.swap("a: 2");
    await vi.waitFor(() => expect(onChange).toHaveBeenCalled(), { timeout: 5_000, interval: 20 });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("treats a file named like the directory as a change, not as the directory going away", async () => {
    const parent = mkdtempSync(join(tmpdir(), "deck-watch-"));
    cleanup.push(() => rmSync(parent, { recursive: true, force: true }));
    const dir = join(parent, "config");
    mkdirSync(dir);
    const logger = { info: vi.fn(), warn: vi.fn() };
    const onChange = vi.fn();
    const watcher = watchDirectory(logger, { checkMs: 60_000 })(dir, onChange);
    cleanup.push(() => watcher.close());

    writeFileSync(join(dir, "config"), "x");
    rmSync(join(dir, "config"));
    await vi.waitFor(() => expect(onChange).toHaveBeenCalled(), { timeout: 5_000, interval: 20 });
    expect(logger.warn).not.toHaveBeenCalled();
    // Still watching (the check is a minute away, so only events can say so).
    onChange.mockClear();
    writeFileSync(join(dir, "00-base.yaml"), "x: 1");
    await vi.waitFor(() => expect(onChange).toHaveBeenCalled(), { timeout: 5_000, interval: 20 });
  });

  it("reports changes under any name, and re-arms when the directory is replaced", async () => {
    const parent = mkdtempSync(join(tmpdir(), "deck-watch-"));
    cleanup.push(() => rmSync(parent, { recursive: true, force: true }));
    const dir = join(parent, "config");
    mkdirSync(dir);
    const logger = { info: vi.fn(), warn: vi.fn() };
    const onChange = vi.fn();
    const watcher = watchDirectory(logger, { checkMs: 50 })(dir, onChange);
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

  it("re-arms when the directory is deleted and made again, even on the same inode", async () => {
    const parent = mkdtempSync(join(tmpdir(), "deck-watch-"));
    cleanup.push(() => rmSync(parent, { recursive: true, force: true }));
    const dir = join(parent, "config");
    mkdirSync(dir);
    writeFileSync(join(dir, "00-base.yaml"), "x: 1");
    const logger = { info: vi.fn(), warn: vi.fn() };
    const onChange = vi.fn();
    const watcher = watchDirectory(logger, { checkMs: 50 })(dir, onChange);
    cleanup.push(() => watcher.close());

    // A deployed directory is older than a clock tick; one made and remade within the same tick
    // (ext4 birth times are coarse) could look the same to stat.
    await new Promise((resolve) => setTimeout(resolve, 50));
    rmSync(dir, { recursive: true });
    mkdirSync(dir);
    await vi.waitFor(() => expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({ state: "rearmed" }), expect.any(String)), { timeout: 5_000, interval: 20 });
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ state: "lost" }), expect.any(String));

    onChange.mockClear();
    writeFileSync(join(dir, "00-base.yaml"), "x: 2");
    await vi.waitFor(() => expect(onChange).toHaveBeenCalled(), { timeout: 5_000, interval: 20 });
  });
});

describe("ui hot reload of a config page", () => {
  const waitFor = (check: () => Promise<void>) => vi.waitFor(check, { timeout: 10_000, interval: 50 });
  const BINDING = { name: "nas", bindings: { link: { id: "nas-wiki", href: "https://wiki.example.net/nas", label: "Wiki" } } };
  const lab = (select: string) => ({
    schemaVersion: 2,
    hosts: [BINDING],
    ui: { pages: [{ id: "lab", path: "/lab", title: "Lab", sections: [{ title: "Links", widgets: [{ id: "wiki", type: "core/json", source: "nas-wiki", select }] }] }] },
  });
  const projections = async (request: Request_) =>
    ((await (await request("/api/providers/nas-wiki")).json()) as { projections?: Record<string, unknown> }).projections;

  it("re-derives the envelope projections with the manifest swap; an invalid edit keeps the last good ones", async () => {
    const dir = mkdtempSync(join(tmpdir(), "deck-reload-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, "00-base.yaml"), stringify({ ...BASE, hosts: [{ name: "nas", kind: "vm", purpose: "Storage" }] }));
    writeFileSync(join(dir, "10-overlay.yaml"), stringify(lab("href")));
    const request = await bootOn(dir);
    await waitFor(async () => expect(await projections(request)).toEqual({ "widget:ui/lab.wiki": { value: "https://wiki.example.net/nas" } }));
    const before = await manifest(request);

    // Only ui changed: the new select is projected as the new manifest is served.
    writeFileSync(join(dir, "10-overlay.yaml"), stringify(lab("label")));
    await waitFor(async () => expect((await manifest(request)).etag).not.toBe(before.etag));
    expect(await projections(request)).toEqual({ "widget:ui/lab.wiki": { value: "Wiki" } });
    expect((await manifest(request)).ui.pages.find((page) => page.id === "page:ui/lab")?.layout?.sections[0]?.widgets[0]?.select).toBe("label");

    // An invalid select does not load: the last good manifest and its projections stay.
    writeFileSync(join(dir, "10-overlay.yaml"), stringify(lab("lenght(label)")));
    await waitFor(async () => expect((await manifest(request)).ui.findings.map((finding) => finding.code)).toEqual(["UI_CONFIG_INVALID"]));
    expect(await projections(request)).toEqual({ "widget:ui/lab.wiki": { value: "Wiki" } });

    // Removing the page removes its projection.
    writeFileSync(join(dir, "10-overlay.yaml"), stringify({ schemaVersion: 2, hosts: [BINDING] }));
    await waitFor(async () => expect((await manifest(request)).ui.pages.some((page) => page.id === "page:ui/lab")).toBe(false));
    expect(await projections(request)).toBeUndefined();
  });
});
