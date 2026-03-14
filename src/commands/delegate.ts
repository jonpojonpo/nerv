import { defineCommand } from "just-bash";

/**
 * delegate — Sub-agent spawn (stub)
 *
 * Phase 04 will wire this to a child runTask() invocation.
 * Currently prints the sub-task prompt and returns a placeholder.
 *
 * Usage: delegate <sub-prompt>
 *        echo "sub-task prompt" | delegate
 */
export const delegateCommand = defineCommand("delegate", async (args, ctx) => {
  const subPrompt = args.join(" ") || ctx.stdin?.trim();

  if (!subPrompt) {
    return {
      stdout: "",
      stderr: "delegate: usage: delegate <sub-prompt>\n",
      exitCode: 1,
    };
  }

  // STUB: Phase 04 will call runTask() recursively
  const stub = [
    `[delegate] STUB — sub-agent spawn not yet implemented`,
    `[delegate] Sub-task received: "${subPrompt}"`,
    `[delegate] Phase 04 will spawn a child task runner with this prompt`,
    `[delegate] Returning placeholder result`,
  ].join("\n");

  return {
    stdout: stub + "\n",
    stderr: "",
    exitCode: 0,
  };
});
