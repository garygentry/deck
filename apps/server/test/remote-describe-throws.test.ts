import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// checkDescribe throws (a bug in deck's own check, not the sidecar's answer).
vi.mock("../src/providers/remote/describe.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/providers/remote/describe.js")>()),
  checkDescribe: () => {
    throw new Error("checker bug with sidecar text <script>");
  },
}));

const { RemoteDirectory } = await import("../src/providers/remote/directory.js");
const { RemoteProvider } = await import("../src/providers/remote/provider.js");

let server: Server;
let url: string;

beforeAll(async () => {
  server = createServer((_req, res) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ deck: 1, id: "ups", version: "1", data: 1 })));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("a describe whose check throws", () => {
  it("is a refusal with a fixed reason: no unhandled rejection, the process carries on, a finding", async () => {
    const directory = new RemoteDirectory();
    directory.declare("ups", "UPS", { path: "/remote/ups" });
    const provider = new RemoteProvider("ups", { url, request: {} }, directory);
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      // A poll starts it in the background, as in deck; the poll itself succeeds.
      await expect(provider.fetch()).resolves.toBe(1);
      await provider.describing();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).not.toHaveBeenCalled();
      const [entry] = directory.snapshot();
      expect(entry?.problem).toEqual({ code: "REMOTE_DESCRIBE_INVALID", message: "deck could not check the describe document" });
      expect(directory.current().findings).toContainEqual(expect.objectContaining({ code: "REMOTE_DESCRIBE_INVALID", id: "page:remote/ups" }));
      const health = await provider.health();
      expect(health).toMatchObject({ ok: true, detail: expect.stringMatching(/describe: invalid \(deck could not check the describe document\)$/) });
      expect(JSON.stringify([entry, health])).not.toContain("<script>");
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });
});
