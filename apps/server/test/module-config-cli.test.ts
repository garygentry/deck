import { afterEach, describe, expect, it, vi } from "vitest";

import { makeConfigDir } from "./util/tmp-config.js";

// One built-in module, switched on by DECK_INV_ON, owning `modules.inv` (an integer `n`).
vi.mock("../src/modules/builtin.js", async () => {
  const { defineServerModule } = await import("@deck/module-sdk");
  return {
    BUILTIN_MODULES: [
      defineServerModule({
        id: "inv",
        version: "1.0.0",
        deckApi: "^0.1",
        enabledBy: { env: "DECK_INV_ON" },
        config: { schema: { type: "object", additionalProperties: false, properties: { n: { type: "integer" } } } },
      }, () => {}),
    ],
  };
});

const { main } = await import("../src/cli/deck.js");

const cleanups: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  while (cleanups.length) cleanups.pop()!();
});

function validate(env: Record<string, string>, flags: string[] = []) {
  const estate = makeConfigDir({ "00-base.yaml": { schemaVersion: 2, estate: { name: "inv" } }, "10-overlay.yaml": { schemaVersion: 2, modules: { inv: { n: "ten" } } } });
  cleanups.push(estate.cleanup);
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  const exit = main(["validate", estate.dir, ...flags]);
  const text = (spy: typeof stdout) => spy.mock.calls.map(([chunk]) => String(chunk)).join("");
  return { exit, stdout: text(stdout), stderr: text(stderr) };
}

describe("deck validate and a disabled module's section (N4)", () => {
  it("fails a switched-off section at its real severity by default, so CI catches it", () => {
    const off = validate({ DECK_INV_ON: "" });
    expect(off.exit).toBe(1);
    expect(off.stderr).toContain("error  /modules/inv/n  SCHEMA_INVALID");
    expect(off.stderr).toContain('info  /modules/inv  MODULE_SECTION_DISABLED  modules.inv is set, but module "inv" is not enabled');
  });

  it("with --advisory-disabled, shows what would fail once the module is enabled, as advisory, and exits 0", () => {
    const off = validate({ DECK_INV_ON: "" }, ["--advisory-disabled"]);
    expect(off.exit).toBe(0);
    expect(off.stdout).toContain('info  /modules/inv/n  MODULE_SECTION_DISABLED  would fail when "inv" is enabled: SCHEMA_INVALID type: must be integer.');
    expect(off.stdout).toContain("clean (advisory only)");
  });

  it("fails the same section once the module is enabled", () => {
    const on = validate({ DECK_INV_ON: "true" });
    expect(on.exit).toBe(1);
    expect(on.stderr).toContain("error  /modules/inv/n  SCHEMA_INVALID");
  });
});
