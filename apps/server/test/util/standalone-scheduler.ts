import type { ScheduledTask, TaskHandle } from "@deck/module-sdk";

import { createAdaptiveTask } from "../../src/modules/scheduler.js";

/**
 * `ctx.scheduler.schedule` outside a module host: the same adaptive-task engine, started at
 * once (the host starts tasks once every module is up).
 */
export function standaloneSchedule(task: ScheduledTask): TaskHandle {
  const handle = createAdaptiveTask({ run: () => task.run(), cadence: task.cadence });
  handle.start();
  return handle;
}
