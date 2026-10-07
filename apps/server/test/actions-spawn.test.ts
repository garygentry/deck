import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { createBunRunnerSpawner } from "../src/actions/spawn.js";

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (chunks: Uint8Array[]) =>
  chunks.map((c) => new TextDecoder().decode(c)).join("");

function streamFrom(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

interface Capture {
  options?: {
    cmd: string[];
    stdin?: Uint8Array;
    stdout?: string;
    stderr?: string;
  };
  kills: (number | NodeJS.Signals | undefined)[];
}

function installFakeBun(capture: Capture): void {
  (globalThis as { Bun?: unknown }).Bun = {
    spawn(options: Capture["options"]) {
      capture.options = options;
      return {
        stdout: streamFrom([enc("hello "), enc("world")]),
        stderr: streamFrom([enc("warn")]),
        exited: Promise.resolve(0),
        kill: (signal?: number | NodeJS.Signals) => capture.kills.push(signal),
      };
    },
  };
}

afterEach(() => {
  delete (globalThis as { Bun?: unknown }).Bun;
});

describe("createBunRunnerSpawner", () => {
  it("references Bun only inside spawn() — importing the module never touches Bun", () => {
    // No global Bun installed here: constructing the spawner must not throw, proving Bun
    // is not referenced at module scope (mirrors lazyServeStatic discipline).
    expect(() => createBunRunnerSpawner()).not.toThrow();
    expect((globalThis as { Bun?: unknown }).Bun).toBeUndefined();
  });

  it("the source references Bun only within spawn(), never at module scope", () => {
    const src = readFileSync(
      fileURLToPath(new URL("../src/actions/spawn.ts", import.meta.url)),
      "utf8",
    );
    // The only executable `Bun.` reference is `Bun.spawn(` inside the spawn() body.
    const refs = src.match(/\bBun\.spawn\(/g) ?? [];
    expect(refs).toHaveLength(1);
    // No top-level `const x = Bun` / bare module-scope Bun usage outside the ambient decl.
    expect(src).not.toMatch(/^const .*=.*\bBun\b/m);
  });

  it("spawn() builds cmd:[executable] only and passes the JSON as stdin bytes", async () => {
    const capture: Capture = { kills: [] };
    installFakeBun(capture);

    const spawner = createBunRunnerSpawner();
    const json = JSON.stringify({ actionId: "restart", params: { host: "db-1" } });
    const run = spawner.spawn("/opt/estate/runners/restart", json);

    // argv is the resolved path ONLY — no interpolated argv, no param on the command line.
    expect(capture.options?.cmd).toEqual(["/opt/estate/runners/restart"]);
    expect(capture.options?.cmd).toHaveLength(1);
    expect(capture.options?.cmd.join(" ")).not.toContain("db-1");

    // The StructuredRunnerInput JSON is written as raw stdin bytes.
    expect(capture.options?.stdin).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(capture.options?.stdin)).toBe(json);
    expect(capture.options?.stdout).toBe("pipe");
    expect(capture.options?.stderr).toBe("pipe");

    // stdout/stderr are exposed as async iterables of the child's chunks.
    const out: Uint8Array[] = [];
    for await (const chunk of run.stdout) out.push(chunk);
    expect(dec(out)).toBe("hello world");

    const err: Uint8Array[] = [];
    for await (const chunk of run.stderr) err.push(chunk);
    expect(dec(err)).toBe("warn");

    expect(await run.exited).toBe(0);
  });

  it("kill() signals the local child only", () => {
    const capture: Capture = { kills: [] };
    installFakeBun(capture);
    const run = createBunRunnerSpawner().spawn("/opt/estate/runners/x", "{}");
    run.kill("SIGTERM");
    expect(capture.kills).toEqual(["SIGTERM"]);
  });
});
