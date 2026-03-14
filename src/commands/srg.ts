import { defineCommand } from "just-bash";

/**
 * srg — Semantic Ripgrep (stub)
 *
 * Phase 04 will wire this to an embedding search backend.
 * Currently falls back to literal grep via just-bash exec.
 *
 * Usage: srg <query> [path]
 */
export const srgCommand = defineCommand("srg", async (args, ctx) => {
  const query = args[0];
  const searchPath = args[1] ?? ".";

  if (!query) {
    return {
      stdout: "",
      stderr: "srg: usage: srg <query> [path]\n",
      exitCode: 1,
    };
  }

  // STUB: literal grep until Phase 04 embedding search
  if (!ctx.exec) {
    return { stdout: "[srg] exec not available in this context\n", stderr: "", exitCode: 1 };
  }
  const result = await ctx.exec(
    `grep -r ${JSON.stringify(query)} ${JSON.stringify(searchPath)} 2>&1 || true`,
    { cwd: ctx.cwd }
  );

  const header = `[srg] STUB — semantic search not yet implemented, running literal grep\n`;
  const footer = `\n[srg] Phase 04 will use embedding-based semantic search\n`;

  return {
    stdout: header + (result.stdout ?? "") + footer,
    stderr: "",
    exitCode: result.exitCode ?? 0,
  };
});
