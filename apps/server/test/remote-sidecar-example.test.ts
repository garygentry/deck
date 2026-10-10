import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";
import { parse } from "yaml";

import { load } from "../src/config/load.js";
import { checkDescribe } from "../../../modules/remote/server/describe.js";
import { RemoteDirectory } from "../../../modules/remote/server/directory.js";
import { RemoteProvider } from "../../../modules/remote/server/provider.js";
import { makeConfigDir } from "./util/tmp-config.js";

const EXAMPLE = fileURLToPath(new URL("../../../examples/sidecars/nut-ups/", import.meta.url));
const TOKEN = "example-sidecar-token";

/**
 * The example sidecar runs under python3. CI must run it: there a missing python3 fails the
 * suite. Locally, without python3, the sidecar's own tests are skipped and say why.
 */
const python = spawnSync("python3", ["--version"], { encoding: "utf8" });
const hasPython = python.status === 0;
const skipReason = hasPython ? "" : " (SKIPPED locally: python3 is not on PATH; CI runs it)";

describe("the example sidecar's prerequisites", () => {
  it("python3 is available wherever CI runs", () => {
    if (process.env.CI) expect(hasPython, `python3 --version failed: ${python.error?.message ?? python.stderr}`).toBe(true);
    else if (!hasPython) console.warn(`examples/sidecars/nut-ups: python3 is not on PATH; its tests are skipped locally`);
  });
});

/** A fake `upsc` on PATH, answering as NUT does. */
function fakeUpsc(): string {
  const dir = mkdtempSync(join(tmpdir(), "deck-upsc-"));
  const script = join(dir, "upsc");
  writeFileSync(
    script,
    [
      "#!/bin/sh",
      'test "$1" = "ups@nut-server" || { echo "Error: Unknown UPS" >&2; exit 1; }',
      "cat <<'OUT'",
      "battery.charge: 97",
      "battery.runtime: 2400",
      "device.model: Back-UPS 1500",
      "input.voltage: 231.0",
      "ups.load: 23",
      "ups.status: OL",
      "OUT",
    ].join("\n"),
  );
  chmodSync(script, 0o755);
  return dir;
}

/** Start the sidecar on an ephemeral port; resolves with its base URL once it listens. */
async function startSidecar(env: Record<string, string>): Promise<{ url: string; child: ChildProcess }> {
  const child = spawn("python3", ["-I", join(EXAMPLE, "nut_ups.py")], {
    env: { PATH: process.env.PATH ?? "", PORT: "0", BIND: "127.0.0.1", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const port = await new Promise<string>((resolve, reject) => {
    let out = "";
    child.stdout!.on("data", (chunk: Buffer) => {
      out += chunk.toString();
      const match = /listening on (\d+)/.exec(out);
      if (match) resolve(match[1]!);
    });
    child.once("exit", (code) => reject(new Error(`sidecar exited (${code})`)));
    setTimeout(() => reject(new Error("sidecar did not start within 10s")), 10_000);
  });
  return { url: `http://127.0.0.1:${port}`, child };
}

describe.skipIf(!hasPython)(`examples/sidecars/nut-ups/nut_ups.py${skipReason}`, () => {
  const cleanups: Array<() => void> = [];
  afterAll(() => cleanups.forEach((cleanup) => cleanup()));

  async function sidecar(token?: string) {
    const bin = fakeUpsc();
    const { url, child } = await startSidecar({
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      NUT_UPS: "ups@nut-server",
      ...(token === undefined ? {} : { SIDECAR_TOKEN: token }),
    });
    cleanups.push(() => {
      child.kill();
      rmSync(bin, { recursive: true, force: true });
    });
    return url;
  }

  it("describes itself with a document deck accepts, and serves its data through the remote provider", async () => {
    const url = await sidecar();
    const describe = await (await fetch(`${url}/deck/v1/describe`)).json();
    expect(checkDescribe(describe, "ups")).toMatchObject({ ok: true, notes: [] });

    const directory = new RemoteDirectory();
    directory.declare("ups", "UPS", { path: "/remote/ups" });
    const provider = new RemoteProvider("ups", { url, request: {} }, directory);
    await expect(provider.fetch()).resolves.toEqual({ status: "OL", load: 23, charge: 97, runtime: 2400, inputVoltage: 231, model: "Back-UPS 1500" });
    await provider.describe();
    expect(directory.snapshot()[0]).toMatchObject({ describe: { id: "ups", version: "1.0.0" } });
    expect(directory.snapshot()[0]?.problem).toBeUndefined();
  }, 20_000);

  it("with a token, refuses a request without it and serves deck's bearer credential from env", async () => {
    const url = await sidecar(TOKEN);
    expect((await fetch(`${url}/deck/v1/data`)).status).toBe(401);
    const directory = new RemoteDirectory();
    directory.declare("ups", "UPS", { path: "/remote/ups" });
    const provider = new RemoteProvider(
      "ups",
      { url, request: { credentialEnv: "UPS_SIDECAR_TOKEN", auth: { scheme: "bearer" }, env: { get: (name) => (name === "UPS_SIDECAR_TOKEN" ? TOKEN : undefined) } } },
      directory,
    );
    await expect(provider.fetch()).resolves.toMatchObject({ status: "OL" });
  }, 20_000);
});

describe("examples/sidecars/nut-ups: the compose snippet and the README's integration", () => {
  it("the compose snippet runs the sidecar read-only, unpublished, with its token from the environment", () => {
    const compose = parse(readFileSync(join(EXAMPLE, "compose.yaml"), "utf8")) as { services: Record<string, Record<string, any>> };
    const service = compose.services["nut-ups"]!;
    expect(service.ports).toBeUndefined();
    expect(service.read_only).toBe(true);
    expect(service.build.dockerfile_inline).toContain('CMD ["python3", "-I", "/app/nut_ups.py"]');
    // Run as documented (from examples/, after examples/compose.yaml), Compose resolves the
    // context against examples/: every COPY source must be there.
    expect(readFileSync(join(EXAMPLE, "README.md"), "utf8")).toContain("docker compose -f compose.yaml -f sidecars/nut-ups/compose.yaml");
    const context = resolve(EXAMPLE, "../..", service.build.context);
    for (const [, source] of (service.build.dockerfile_inline as string).matchAll(/^\s*COPY\s+(\S+)\s+\S+$/gm)) {
      expect(existsSync(join(context, source!)), `COPY ${source} from ${context}`).toBe(true);
    }
    expect(service.environment.SIDECAR_TOKEN).toMatch(/^\$\{UPS_SIDECAR_TOKEN:\?/);
    expect(compose.services.deck!.environment.UPS_SIDECAR_TOKEN).toMatch(/^\$\{UPS_SIDECAR_TOKEN:\?/);
  });

  it("the README's integration is a valid remote integration", () => {
    const readme = readFileSync(join(EXAMPLE, "README.md"), "utf8");
    const block = /```yaml\n([\s\S]*?)```/.exec(readme)![1]!;
    const dir = makeConfigDir({
      "00-base.yaml": { schemaVersion: 2, estate: { name: "ups" } },
      "10-overlay.yaml": { schemaVersion: 2, ...(parse(block) as object) },
    });
    try {
      const result = load({ arg: dir.dir, env: { UPS_SIDECAR_TOKEN: TOKEN } });
      expect(result.findings.filter((finding) => finding.severity !== "info")).toEqual([]);
    } finally {
      dir.cleanup();
    }
  });
});
