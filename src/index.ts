/**
 * NERV — MAGI Agent Terminal System
 * 特務機関NERV // PUBLIC API
 */

export { runTask } from "./runner.js";
export type { RunConfig, RunResult } from "./runner.js";

export { createSandbox } from "./sandbox.js";
export type { SandboxConfig, SandboxResult } from "./sandbox.js";

export { TaskStream } from "./streaming.js";
export type { TaskEvent } from "./streaming.js";

/**
 * Convenience factory — create a reusable task runner with shared config.
 *
 * @example
 * ```typescript
 * import { createTaskRunner } from "nerv";
 *
 * const runner = createTaskRunner({ dataMount: "./corpus" });
 * const result = await runner.run({ prompt: "analyse data" });
 * ```
 */
export function createTaskRunner(defaults: {
  dataMount?: string;
  network?: { allowedUrlPrefixes: string[] };
}) {
  return {
    run: (
      config: import("./runner.js").RunConfig
    ): Promise<import("./runner.js").RunResult> => {
      return runTask({
        dataMount: defaults.dataMount,
        network: defaults.network,
        ...config,
      });
    },
  };
}

// Re-export runTask as default for convenience
import { runTask } from "./runner.js";
