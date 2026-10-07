// @vitest-environment jsdom
//
// Render coverage for the owned-configs entity fragment. The fragment fetches its OWN data (config
// via `useConfig`, per-source manifests via `fetchManifest`), so its output is effect-driven: it is
// rendered with Testing Library against a stubbed global `fetch` and queried once it settles. The
// pure ownership / path helpers are additionally asserted directly.

import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  DeckConfig,
  ProviderEnvelope,
  SourceManifest,
  SourceTreeNode,
} from "@deck/server";
import type { EntityRef } from "../src/registry/registry.js";

import {
  OwnedConfigsFragment,
  collectFilePaths,
  ownedFileTreeSources,
} from "../src/features/sources-docs-and-configs/OwnedConfigsFragment.js";
import type { Source } from "../src/features/sources-docs-and-configs/client.js";
import { configsHref } from "../src/features/sources-docs-and-configs/links.js";

// --- fixtures -------------------------------------------------------------

function fileNode(path: string, name: string): SourceTreeNode {
  return { path, name, type: "file", size: 16, binary: false };
}

function dirNode(path: string, name: string, children: SourceTreeNode[]): SourceTreeNode {
  return { path, name, type: "dir", children };
}

function source(
  id: string,
  kind: "file-tree" | "markdown-tree",
  owner?: { host: string; service?: string },
): Source {
  return {
    id,
    kind,
    title: `${id} title`,
    location: { path: `/srv/${id}` },
    ...(owner ? { owner } : {}),
  };
}

function config(sources: Source[]): DeckConfig {
  return { sources } as unknown as DeckConfig;
}

function manifest(sourceId: string, children: SourceTreeNode[]): SourceManifest {
  return {
    sourceId,
    kind: "file-tree",
    title: `${sourceId} title`,
    fileCount: children.filter((c) => c.type === "file").length,
    tree: { path: "", name: "", type: "dir", children },
  };
}

function envelope(
  sourceId: string,
  data: SourceManifest | null,
): ProviderEnvelope<SourceManifest> {
  return {
    id: sourceId,
    kind: "file-tree",
    freshness: { state: "fresh", observedAt: "2026-09-17T00:00:00.000Z", ageMs: 1_000, ttlMs: 30_000 },
    data,
    error: data === null ? { message: "unavailable" } : null,
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Stub the global `fetch` so `useConfig` (GET /api/config) and `fetchManifest`
 * (GET /api/providers/:id) resolve from in-memory fixtures. Any other URL rejects.
 */
function stubFetch(cfg: DeckConfig, manifests: Record<string, ProviderEnvelope<SourceManifest>>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/config") return jsonResponse(cfg);
      if (url.startsWith("/api/providers/")) {
        const id = decodeURIComponent(url.slice("/api/providers/".length));
        const env = manifests[id];
        if (env) return jsonResponse(env);
      }
      throw new Error(`unexpected fetch: ${url}`);
    }),
  );
}

function renderFragment(entity: EntityRef): HTMLElement {
  return render(<OwnedConfigsFragment entity={entity} />).container;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// --- pure helpers ---------------------------------------------------------

describe("ownedFileTreeSources (REQ-FRAG-02)", () => {
  const cfg = config([
    source("cfg-a", "file-tree", { host: "web01" }),
    source("cfg-b", "file-tree", { host: "db01" }),
    source("docs-a", "markdown-tree", { host: "web01" }),
    source("cfg-unowned", "file-tree"),
    source("svc-a", "file-tree", { host: "web01", service: "nginx" }),
    source("svc-b", "file-tree", { host: "web01", service: "redis" }),
  ]);

  it("host page lists file-tree sources whose owner.host matches (incl. service-scoped)", () => {
    const owned = ownedFileTreeSources(cfg, { entity: "host", host: "web01" });
    expect(owned.map((s) => s.id)).toEqual(["cfg-a", "svc-a", "svc-b"]);
  });

  it("excludes non-file-tree kinds, other hosts, and unowned sources", () => {
    const owned = ownedFileTreeSources(cfg, { entity: "host", host: "web01" });
    expect(owned.map((s) => s.id)).not.toContain("docs-a"); // markdown-tree
    expect(owned.map((s) => s.id)).not.toContain("cfg-b"); // other host
    expect(owned.map((s) => s.id)).not.toContain("cfg-unowned"); // no owner
  });

  it("service page additionally filters by owner.service (EntityRef.name)", () => {
    const owned = ownedFileTreeSources(cfg, {
      entity: "service",
      host: "web01",
      name: "nginx",
    });
    expect(owned.map((s) => s.id)).toEqual(["svc-a"]);
  });
});

describe("collectFilePaths", () => {
  it("flattens files depth-first, excluding directory nodes", () => {
    const tree = dirNode("", "", [
      fileNode("app.yaml", "app.yaml"),
      dirNode("nested", "nested", [fileNode("nested/deep.json", "deep.json")]),
    ]);
    expect(collectFilePaths(tree)).toEqual(["app.yaml", "nested/deep.json"]);
  });
});

// --- rendered fragment ----------------------------------------------------

describe("OwnedConfigsFragment (rendered)", () => {
  it("lists a host's owned files, each linking to /configs?source=<id>&path=<rel>", async () => {
    const cfg = config([
      source("cfg-a", "file-tree", { host: "web01" }),
      source("cfg-b", "file-tree", { host: "db01" }),
    ]);
    stubFetch(cfg, {
      "cfg-a": envelope(
        "cfg-a",
        manifest("cfg-a", [
          fileNode("app.yaml", "app.yaml"),
          dirNode("etc", "etc", [fileNode("etc/site.conf", "site.conf")]),
        ]),
      ),
      "cfg-b": envelope("cfg-b", manifest("cfg-b", [fileNode("db.yaml", "db.yaml")])),
    });

    const el = renderFragment({ entity: "host", host: "web01" });
    const list = await screen.findByRole("list", { name: "Config files owned by this entity" });
    const links = await within(list).findAllByRole("link");
    const hrefs = links.map((a) => a.getAttribute("href"));

    expect(hrefs).toEqual([
      configsHref("cfg-a", "app.yaml"),
      configsHref("cfg-a", "etc/site.conf"),
    ]);
    // The href is the /configs deep link for the owned source + relative path (REQ-FRAG-03).
    expect(hrefs[0]).toBe("/configs?source=cfg-a&path=app.yaml");
    expect(within(list).getByRole("link", { name: "etc/site.conf" })).toBeTruthy();
    // The source is named, with its freshness (icon + text).
    expect(within(list).getByText("cfg-a title")).toBeTruthy();
    expect(within(list).getByText("Fresh")).toBeTruthy();
    // The other host's source is never listed.
    expect(el.textContent).not.toContain("db.yaml");
    // The fragment root is a data-slot subtree.
    expect(el.firstElementChild?.getAttribute("data-slot")).toBe("owned-configs");
  });

  it("filters by owner.service on a service entity", async () => {
    const cfg = config([
      source("svc-nginx", "file-tree", { host: "web01", service: "nginx" }),
      source("svc-redis", "file-tree", { host: "web01", service: "redis" }),
    ]);
    stubFetch(cfg, {
      "svc-nginx": envelope(
        "svc-nginx",
        manifest("svc-nginx", [fileNode("nginx.conf", "nginx.conf")]),
      ),
      "svc-redis": envelope(
        "svc-redis",
        manifest("svc-redis", [fileNode("redis.conf", "redis.conf")]),
      ),
    });

    const el = renderFragment({ entity: "service", host: "web01", name: "nginx" });
    const links = await screen.findAllByRole("link");
    expect(links.map((a) => a.getAttribute("href"))).toEqual([configsHref("svc-nginx", "nginx.conf")]);
    expect(el.textContent).not.toContain("redis.conf");
  });

  it("marks an owned source that failed to acquire as unavailable (role=alert)", async () => {
    const cfg = config([source("cfg-a", "file-tree", { host: "web01" })]);
    stubFetch(cfg, { "cfg-a": envelope("cfg-a", null) });

    renderFragment({ entity: "host", host: "web01" });
    expect((await screen.findByRole("alert")).textContent).toBe("Unavailable");
    expect(screen.queryAllByRole("link")).toHaveLength(0);
  });

  it("renders a role=status empty state when the entity owns no config files (REQ-FRAG-04)", async () => {
    const cfg = config([
      source("cfg-b", "file-tree", { host: "db01" }),
      source("docs-a", "markdown-tree", { host: "web01" }),
    ]);
    stubFetch(cfg, {});

    renderFragment({ entity: "host", host: "web01" });
    const status = await screen.findByText("No config files are owned by this entity.");
    expect(status.closest("[role=status]")).not.toBeNull();
    // Distinct from the slot's own "nothing attached" fallback, and not a blank region.
    expect(screen.queryAllByRole("link")).toHaveLength(0);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
