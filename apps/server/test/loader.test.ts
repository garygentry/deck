import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import * as schema from "@deck/schema";
import { invalid, primary } from "@deck/schema/fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import { load } from "../src/config/load.js";
import { resolveConfigDir } from "../src/config/resolve-dir.js";
import * as modulesConfig from "../src/modules/config.js";
import { makeConfigDir } from "./util/tmp-config.js";

const cleanDocument = { schemaVersion: 2, estate: { name: "loader-test" } };
const cleanDir = () => makeConfigDir({ "00-base.yaml": cleanDocument });
const temporary: Array<() => void> = [];

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  while (temporary.length) temporary.pop()!();
});

function tracked(layers: Record<string, unknown>) {
  const result = makeConfigDir(layers);
  temporary.push(result.cleanup);
  return result;
}

describe("resolveConfigDir", () => {
  it("returns YAML files as absolute byte-order-sorted paths", () => {
    const { dir } = tracked({ "z.yml": cleanDocument, "A.yaml": cleanDocument, "ignored.json": {} });
    const result = resolveConfigDir({ arg: dir });
    expect(result.ok && result.files).toEqual([join(dir, "A.yaml"), join(dir, "z.yml")]);
  });

  it("prefers an explicit argument over DECK_CONFIG_DIR", () => {
    const argument = tracked({ "00.yaml": cleanDocument });
    const environment = tracked({ "00.yaml": cleanDocument });
    vi.stubEnv("DECK_CONFIG_DIR", environment.dir);
    expect(resolveConfigDir({ arg: argument.dir })).toMatchObject({ ok: true, dir: argument.dir });
  });

  it("uses DECK_CONFIG_DIR when there is no argument", () => {
    const environment = tracked({ "00.yaml": cleanDocument });
    vi.stubEnv("DECK_CONFIG_DIR", environment.dir);
    expect(resolveConfigDir()).toMatchObject({ ok: true, dir: environment.dir });
  });

  it("defaults to ./config relative to cwd", () => {
    const root = tracked({ "placeholder.yaml": cleanDocument });
    const config = join(root.dir, "config");
    mkdirSync(config);
    writeFileSync(join(config, "00.yaml"), "schemaVersion: 2\nestate:\n  name: loader-test\n");
    expect(resolveConfigDir({ env: {}, cwd: root.dir })).toMatchObject({ ok: true, dir: config });
  });
});

describe("load", () => {
  it("validates base, overlay against the accumulator, then merged", () => {
    const validate = vi.spyOn(schema, "validate");
    const result = load({ arg: dirname(primary.paths.base) });
    expect(validate.mock.calls.map(([, options]) => options?.layer)).toEqual(["base", "overlay", "merged"]);
    expect(validate.mock.calls[1][1]).toMatchObject({ layer: "overlay", base: primary.base });
    // Every call validates against the one composition of the built-in modules.
    expect(new Set(validate.mock.calls.map(([, options]) => options?.composed)).size).toBe(1);
    expect(result.exitClass).toBe(0);
    if (result.exitClass === 0) expect(result.config).toEqual(primary.merged);
  });

  it("resolves references introduced by an earlier overlay against the accumulated merge", () => {
    const validate = vi.spyOn(schema, "validate");
    const host = { name: "cross-overlay", kind: "vm", purpose: "loader test" };
    const { dir } = tracked({
      "00-base.yaml": cleanDocument,
      "10-host.yaml": { schemaVersion: 2, hosts: [host] },
      "20-layout.yaml": {
        schemaVersion: 2,
        modules: { portal: { groups: [{ id: "cross-overlay", title: "Cross overlay", items: [{ type: "host", host: host.name }] }] } },
      },
    });
    load({ arg: dir });
    const laterOverlayOptions = validate.mock.calls[2][1];
    expect(laterOverlayOptions?.layer).toBe("overlay");
    expect(laterOverlayOptions?.base).toMatchObject({ hosts: [host] });
    const laterOverlayResult = validate.mock.results[2].value;
    expect(laterOverlayResult.findings.some(({ code }: { code: string }) => code === "OVERLAY_DANGLING_REF")).toBe(false);
  });

  it("returns a deeply frozen config on exit 0", () => {
    const result = load({ arg: dirname(primary.paths.base) });
    expect(result.exitClass).toBe(0);
    if (result.exitClass !== 0) return;
    expect(Object.isFrozen(result.config)).toBe(true);
    expect(Object.isFrozen(result.config.estate)).toBe(true);
    expect(() => { (result.config.estate as { name: string }).name = "mutated"; }).toThrow(TypeError);
  });

  it("missing directory maps to CONFIG_DIR_MISSING", () => {
    const result = load({ arg: join(process.cwd(), "does-not-exist-loader-test") });
    expect(result).toMatchObject({ exitClass: 2, toolError: { code: "CONFIG_DIR_MISSING" } });
  });

  it("empty directory maps to CONFIG_DIR_EMPTY", () => {
    const { dir } = tracked({});
    const result = load({ arg: dir });
    expect(result).toMatchObject({ exitClass: 2, toolError: { code: "CONFIG_DIR_EMPTY" } });
  });

  it("unparseable YAML maps to CONFIG_YAML_PARSE and names its path", () => {
    const { dir } = tracked({});
    const path = join(dir, "00-base.yaml");
    writeFileSync(path, ": : [");
    expect(load({ arg: dir })).toMatchObject({ exitClass: 2, toolError: { code: "CONFIG_YAML_PARSE", path } });
  });

  it("MergeError maps to CONFIG_MERGE_ERROR with upstream details", () => {
    const { dir } = tracked({
      "00-base.yaml": cleanDocument,
      "10-overlay.yaml": { schemaVersion: 3 },
    });
    const result = load({ arg: dir });
    expect(result).toMatchObject({ exitClass: 2, toolError: { code: "CONFIG_MERGE_ERROR", path: "/schemaVersion" } });
    if (result.exitClass === 2) expect(result.toolError.message).toContain("MERGE_VERSION_MISMATCH");
  });

  it("a schemaVersion 1 layer maps to CONFIG_MIGRATION_REQUIRED naming deck config migrate and the dir", () => {
    for (const layers of [
      { "00-base.yaml": { ...cleanDocument, schemaVersion: 1 } },
      { "00-base.yaml": cleanDocument, "10-overlay.yaml": { schemaVersion: 1 } },
    ]) {
      const { dir } = tracked(layers);
      const result = load({ arg: dir });
      expect(result).toMatchObject({ exitClass: 2, findings: [], toolError: { code: "CONFIG_MIGRATION_REQUIRED" } });
      if (result.exitClass === 2) expect(result.toolError.message).toContain(`deck config migrate ${dir}`);
    }
  });

  it("a module contribution conflict maps to exit 2 instead of throwing", () => {
    const composed = vi.spyOn(modulesConfig, "builtinComposition").mockImplementation(() => {
      throw new schema.ComposeError("MODULE_MANIFEST_CONFLICT", "twin", "duplicate module id");
    });
    expect(load({ arg: tracked({ "00-base.yaml": cleanDocument }).dir })).toMatchObject({ exitClass: 2, toolError: { code: "MODULE_MANIFEST_CONFLICT" } });
    composed.mockRestore();
  });

  it("validate classification 2 maps to exit 2 without throwing", () => {
    const { dir } = tracked({ "00-base.yaml": null });
    expect(load({ arg: dir })).toMatchObject({ exitClass: 2, toolError: { code: "INPUT_NOT_OBJECT" } });
  });

  it("validation error or warning maps to exit 1", () => {
    const fixture = invalid.find(({ layer }) => layer === "base")!;
    const { dir } = tracked({ "00-base.yaml": fixture.document });
    const result = load({ arg: dir });
    expect(result.exitClass).toBe(1);
    expect(result.findings.some(({ code }) => code === fixture.expect)).toBe(true);
  });

  it("reports an undeclared portal service from the YAML fixture", () => {
    const result = load({ arg: "test/fixtures/portal-broken-ref" });

    expect(result).toMatchObject({
      exitClass: 1,
      config: null,
      findings: expect.arrayContaining([
        expect.objectContaining({
          code: "REF_SERVICE_UNRESOLVED",
          severity: "error",
          path: "/modules/portal/groups/0/items/0",
        }),
      ]),
    });
  });

  it("the primary fixture maps to exit 0", () => {
    expect(load({ arg: dirname(primary.paths.base) })).toMatchObject({ exitClass: 0, config: primary.merged });
  });
});
