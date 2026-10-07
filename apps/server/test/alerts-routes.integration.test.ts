import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Logger } from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import { load } from "../src/config/load.js";
import { registerAllProviders } from "../src/providers/index.js";
import { listHealth, listProviders, providerCount, read, stopScheduler } from "../src/providers/registry.js";
import { createApp } from "../src/server/app.js";

const providersDir = join(dirname(fileURLToPath(import.meta.url)), "../src/providers");

function makeApp(fixture: string) {
  const result = load({ arg: `test/fixtures/${fixture}` });
  expect(result.exitClass).toBe(0);
  if (result.exitClass !== 0) throw new Error(`${fixture} fixture did not load`);

  registerAllProviders(result.config);
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger;
  const app = createApp({
    config: result.config,
    providers: { read, count: providerCount, listHealth, listProviders },
    logger,
  });
  return { app, config: result.config };
}

describe("alerts-and-health provider routes", () => {
  afterEach(() => {
    stopScheduler();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("serves prometheus and alertmanager envelopes from the alerts-estate fixture", async () => {
    const { app } = makeApp("alerts-estate");

    for (const id of ["prometheus", "alertmanager"]) {
      const response = await app.request(`/api/providers/${id}`);
      expect(response.status).toBe(200);
      const envelope = await response.json();
      expect(envelope).toMatchObject({
        id,
        kind: id,
        freshness: { state: "pending", observedAt: null, ageMs: null },
        data: null,
        error: null,
      });
      // Well-formed ProviderEnvelope: exactly the contract keys, no extras.
      expect(Object.keys(envelope).sort()).toEqual(
        ["data", "error", "freshness", "id", "kind"].sort(),
      );
      expect(Object.keys(envelope.freshness).sort()).toEqual(
        ["ageMs", "observedAt", "state", "ttlMs"].sort(),
      );
    }
  });

  it("returns 404 PROVIDER_NOT_FOUND for a kind that is not configured", async () => {
    // portal-estate declares only docker/gatus integrations — no prometheus/alertmanager.
    const { app } = makeApp("portal-estate");

    for (const id of ["prometheus", "alertmanager"]) {
      const response = await app.request(`/api/providers/${id}`);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({
        error: `No provider registered with id '${id}'`,
        code: "PROVIDER_NOT_FOUND",
      });
    }
  });

  it("registers exactly one provider per kind despite a second same-kind integration", () => {
    // alerts-estate declares two prometheus integrations, one alertmanager, one opaque kind.
    makeApp("alerts-estate");

    // Only the first prometheus and the alertmanager register; the second prometheus is
    // latched out by the guard and the opaque kind is never wired.
    expect(providerCount()).toBe(2);
    expect(read("prometheus")).toBeDefined();
    expect(read("alertmanager")).toBeDefined();
    // Providers register under fixed ids only, never under an integration id.
    expect(read("prometheus-secondary")).toBeUndefined();
    expect(read("opaque-tool")).toBeUndefined();
    expect(read("file-tree")).toBeUndefined();
  });

  it("exposes no non-GET route for the provider endpoints (read-only feature)", async () => {
    const { app } = makeApp("alerts-estate");

    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const response = await app.request("/api/providers/prometheus", { method });
      expect(response.status).toBe(404);
    }
  });
});

/**
 * Provider-barrel drift guard: regenerate the barrel into a buffer using the same rules as
 * src/scripts/gen-providers.ts and assert byte-equality with the checked-in generated.ts.
 * Fails if a folder was added/removed without running `pnpm gen:providers`, or on a hand-edit.
 */
describe("provider-barrel drift guard", () => {
  function helperName(folder: string): string {
    return `register${folder
      .split("-")
      .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
      .join("")}`;
  }

  function compareText(a: string, b: string): number {
    return a < b ? -1 : a > b ? 1 : 0;
  }

  function providerFolders(): string[] {
    return readdirSync(providersDir)
      .filter((name) => statSync(join(providersDir, name)).isDirectory())
      .filter((name) => {
        try {
          return statSync(join(providersDir, name, "index.ts")).isFile();
        } catch {
          return false;
        }
      })
      .sort(compareText);
  }

  function regenerate(): string {
    const HEADER =
      "/* GENERATED from provider index.ts files by src/scripts/gen-providers.ts — do not edit; run `pnpm gen:providers`. */";
    const folders = providerFolders();
    const providers = folders
      .map((kind) => ({ kind, order: 0 }))
      .sort((a, b) => a.order - b.order || compareText(a.kind, b.kind));
    const imports = folders.map(
      (folder) => `import { ${helperName(folder)} } from "./${folder}/index.js";`,
    );
    const helpers = folders.map(helperName);
    return [
      HEADER,
      ...imports,
      "",
      "/** One discovered provider folder's registration surface. */",
      "export interface GeneratedProviderEntry {",
      "  kind: string;",
      "  order: number;",
      "}",
      "",
      "/** Provider kinds discovered at codegen time, sorted by (order, kind). */",
      "export const GENERATED_PROVIDERS: readonly GeneratedProviderEntry[] = [",
      ...providers.map(({ kind, order }) => `  { kind: "${kind}", order: ${order} },`),
      "];",
      "",
      "/** Typed registration helpers exposed by the discovered provider folders. */",
      `export { ${helpers.join(", ")} };`,
      "",
    ].join("\n");
  }

  it("checked-in generated.ts is byte-equal to a fresh regeneration", () => {
    const checkedIn = readFileSync(join(providersDir, "generated.ts"), "utf8");
    expect(checkedIn).toBe(regenerate());
  });

  it("barrel re-exports registerPrometheus/registerAlertmanager and lists both kinds", () => {
    const generated = readFileSync(join(providersDir, "generated.ts"), "utf8");
    const exported = /export \{([^}]*)\};/.exec(generated)?.[1] ?? "";
    const names = exported.split(",").map((name) => name.trim());
    expect(names).toContain("registerPrometheus");
    expect(names).toContain("registerAlertmanager");
    expect(generated).toMatch(/\{ kind: "prometheus", order: 0 \}/);
    expect(generated).toMatch(/\{ kind: "alertmanager", order: 0 \}/);
  });
});
