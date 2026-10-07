/**
 * A deck process for the shutdown tests: the real `main()` (boot plus signal handling)
 * running one probe module whose behaviour SHUTDOWN_SCENARIO picks, with short bounds.
 */
import { defineServerModule } from "@deck/module-sdk";

import { main } from "../../../src/server/boot.js";

const scenario = process.env.SHUTDOWN_SCENARIO ?? "idle";
const never = () => new Promise<void>(() => {});
// A hang that waits on I/O, as a real one does: something keeps the event loop alive.
const hangOnIo = () => new Promise<void>(() => void setInterval(() => {}, 1_000));

const probe = defineServerModule({ id: "probe", version: "1.0.0", deckApi: "^0.1" }, async (ctx) => {
  ctx.logger.info({ event: "probe.init-started" });
  if (scenario === "hung-init") await hangOnIo();
  if (scenario === "slow-init") await new Promise((resolve) => setTimeout(resolve, 1_500));
  if (scenario === "hung-hook") ctx.onStop(never);
  ctx.http.get("/ping", (c) => c.text("pong"));
  // A response that never ends: its first chunk arrives, then the stream stays open.
  ctx.http.get("/hold", () => new Response(new ReadableStream({ start: (controller) => controller.enqueue(new TextEncoder().encode("held\n")) })));
});

main({
  modules: [probe],
  shutdown: { drainTimeoutMs: 300, hookTimeoutMs: 1_000, graceMs: 500 },
  shutdownDeadlineMs: Number(process.env.SHUTDOWN_DEADLINE_MS ?? 5_000),
});
