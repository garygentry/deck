/**
 * The actions module's real config wiring (its manifest's schema, identity rows, references
 * and ownership), driven through `load()` and `deck validate`: with the capability on, as
 * boot sees it, and with it off, where `deck validate` still holds the section to its real
 * severity unless `--advisory-disabled` asks for advisory findings.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { FINDING_CATALOG } from "@deck/schema";

import { runValidate } from "../src/cli/validate.js";
import { load } from "../src/config/load.js";
import { makeConfigDir } from "./util/tmp-config.js";

const temporary: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  while (temporary.length) temporary.pop()!();
});

const BASE = {
  schemaVersion: 2,
  estate: { name: "actions-config" },
  hosts: [{ name: "web01", kind: "vm", purpose: "Web host" }],
  services: [{ host: "web01", name: "nginx", kind: "systemd", purpose: "Web server" }],
};
const action = (id: string, extra: Record<string, unknown> = {}) => ({ id, title: id, runner: "echo-runner", confirm: "none", ...extra });
const overlay = (actions: unknown[]) => ({ schemaVersion: 2, modules: { actions: { actions } } });

function estate(layers: Record<string, unknown>): string {
  const { dir, cleanup } = makeConfigDir(layers);
  temporary.push(cleanup);
  return dir;
}

const ON = { DECK_ACTIONS_ENABLED: "true" };

/** Each probe: the layers, and the finding (code + path) it must raise; every one fails validation. */
const BROKEN: ReadonlyArray<[label: string, layers: Record<string, unknown>, code: string, path: string]> = [
  ["a duplicate action id", { "00-base.yaml": BASE, "10-overlay.yaml": overlay([action("a"), action("a")]) }, "ID_DUPLICATE", "/modules/actions/actions/1"],
  ["an unresolved host target", { "00-base.yaml": BASE, "10-overlay.yaml": overlay([action("a", { target: { host: "nowhere" } })]) }, "REF_HOST_UNRESOLVED", "/modules/actions/actions/0/target/host"],
  ["an unresolved service target", { "00-base.yaml": BASE, "10-overlay.yaml": overlay([action("a", { target: { host: "web01", service: "gone" } })]) }, "REF_SERVICE_UNRESOLVED", "/modules/actions/actions/0/target/service"],
  ["an overlay target dangling from the base", { "00-base.yaml": BASE, "10-overlay.yaml": overlay([action("a", { target: { host: "nowhere" } })]) }, "OVERLAY_DANGLING_REF", "/modules/actions/actions/0/target/host"],
  ["the section in the base layer", { "00-base.yaml": { ...BASE, modules: { actions: { actions: [action("a")] } } } }, "LAYER_OVERLAY_KEY_IN_BASE", "/modules/actions/actions/0/id"],
  ["a schema error", { "00-base.yaml": BASE, "10-overlay.yaml": overlay([action("a", { confirm: "yolo" })]) }, "SCHEMA_INVALID", "/modules/actions/actions/0/confirm"],
];

describe("modules.actions with the capability on (as boot loads it)", () => {
  it.each(BROKEN)("fails %s with exit 1", (_label, layers, code, path) => {
    const result = load({ arg: estate(layers), env: ON });
    expect(result.exitClass).toBe(1);
    expect(result.findings).toContainEqual(expect.objectContaining({ code, path, severity: FINDING_CATALOG[code as keyof typeof FINDING_CATALOG].severity }));
  });

  it("accepts duplicate param names within one action, as deck always has", () => {
    const params = [{ name: "x", type: "string" }, { name: "x", type: "string" }];
    const result = load({ arg: estate({ "00-base.yaml": BASE, "10-overlay.yaml": overlay([action("a", { params })]) }), env: ON });
    expect(result).toMatchObject({ exitClass: 0, findings: [] });
  });

  it("accepts resolved host and service targets", () => {
    const targets = [action("a", { target: { host: "web01" } }), action("b", { target: { host: "web01", service: "nginx" } })];
    expect(load({ arg: estate({ "00-base.yaml": BASE, "10-overlay.yaml": overlay(targets) }), env: ON })).toMatchObject({ exitClass: 0, findings: [] });
  });
});

describe("modules.actions with the capability off", () => {
  it.each(BROKEN)("boot is never blocked by %s: the problem is advisory", (_label, layers) => {
    const result = load({ arg: estate(layers), env: {} });
    expect(result.exitClass).toBe(0);
    expect(result.findings.every((finding) => finding.severity === "info")).toBe(true);
    expect(result.findings).toContainEqual(expect.objectContaining({ code: "MODULE_SECTION_DISABLED", path: "/modules/actions" }));
  });

  it.each(BROKEN)("deck validate still fails %s at its real severity (exit 1)", (_label, layers, code, path) => {
    vi.stubEnv("DECK_ACTIONS_ENABLED", "");
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    expect(runValidate([estate(layers)])).toBe(1);
    const output = stderr.mock.calls.map(([text]) => String(text)).join("");
    expect(output).toContain(`${FINDING_CATALOG[code as keyof typeof FINDING_CATALOG].severity}  ${path}  ${code}  `);
    expect(output).toContain("info  /modules/actions  MODULE_SECTION_DISABLED  ");
    vi.unstubAllEnvs();
  });

  // Advisory keeps the switched-off section out of the layer-ownership check altogether.
  it.each(BROKEN.filter(([, , code]) => code !== "LAYER_OVERLAY_KEY_IN_BASE"))("deck validate --advisory-disabled reports %s at info (exit 0)", (_label, layers) => {
    vi.stubEnv("DECK_ACTIONS_ENABLED", "");
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(runValidate([estate(layers), "--advisory-disabled"])).toBe(0);
    const output = stdout.mock.calls.map(([text]) => String(text)).join("");
    expect(output).toContain("would fail when \"actions\" is enabled");
    expect(output.trimEnd().endsWith("clean (advisory only)")).toBe(true);
    vi.unstubAllEnvs();
  });

  it("deck validate passes a clean section with one info line in either mode", () => {
    vi.stubEnv("DECK_ACTIONS_ENABLED", "");
    const dir = estate({ "00-base.yaml": BASE, "10-overlay.yaml": overlay([action("a", { target: { host: "web01" } })]) });
    for (const argv of [[dir], [dir, "--advisory-disabled"]]) {
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      expect(runValidate(argv)).toBe(0);
      expect(stdout.mock.calls.map(([text]) => String(text)).join("")).toBe(
        'info  /modules/actions  MODULE_SECTION_DISABLED  modules.actions is set, but module "actions" is not enabled (not enabled: DECK_ACTIONS_ENABLED is not true); the section is ignored.\nclean (advisory only)\n',
      );
      stdout.mockRestore();
    }
    vi.unstubAllEnvs();
  });
});
