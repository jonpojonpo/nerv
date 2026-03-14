#!/usr/bin/env node
import { Command } from "commander";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import { runTask } from "./runner.js";
import { TaskStream } from "./streaming.js";

// If called as `nerv --prompt "..."` (no subcommand), inject "run"
const knownSubcommands = ["run", "help", "--help", "-h", "--version", "-V"];
if (
  process.argv.length > 2 &&
  !knownSubcommands.some((s) => process.argv[2] === s)
) {
  process.argv.splice(2, 0, "run");
}

const program = new Command();

program
  .name("nerv")
  .description("MAGI Agent Terminal System — 特務機関NERV")
  .version("0.1.0");

program
  .command("run")
  .description("Run an agent task")
  .option("--prompt <text>", "Task prompt (or - to read from stdin)")
  .option("--file <path...>", "Input file(s) to inject into /input/")
  .option("--output <format>", "Output format: text|json", "text")
  .option("--watch", "Stream with ANSI formatting to tty")
  .option("--allow-url <prefix...>", "Network URL prefixes to allow")
  .action(async (opts) => {
    let prompt: string = opts.prompt ?? "";

    if (!prompt || prompt === "-") {
      if (process.stdin.isTTY) {
        console.error(
          "[NERV] Error: --prompt required or pipe prompt via stdin"
        );
        process.exit(1);
      }
      prompt = readFileSync("/dev/stdin", "utf-8").trim();
    }

    if (!prompt) {
      console.error("[NERV] Error: empty prompt");
      process.exit(1);
    }

    // Build input files map — read as Buffer to handle binary files (xlsx etc.)
    const files: Record<string, string | Buffer> = {};
    if (opts.file) {
      for (const filePath of opts.file as string[]) {
        const abs = resolve(filePath);
        if (!existsSync(abs)) {
          console.error(`[NERV] File not found: ${filePath}`);
          process.exit(1);
        }
        const name = abs.split("/").pop()!;
        const ext = name.split(".").pop()?.toLowerCase() ?? "";
        const binaryExts = new Set(["xlsx", "xls", "xlsm", "xlsb", "ods", "pdf", "db", "sqlite"]);
        files[name] = binaryExts.has(ext)
          ? readFileSync(abs)           // Buffer for binary files
          : readFileSync(abs, "utf-8"); // string for text files
      }
    }

    // Inject prompt as task.md if not already provided
    if (!files["task.md"]) {
      files["task.md"] = prompt;
    }

    const network =
      opts.allowUrl
        ? { allowedUrlPrefixes: opts.allowUrl as string[] }
        : undefined;

    const stream = new TaskStream();

    if (opts.watch || process.stdout.isTTY) {
      process.stdout.write(
        `\x1b[32m╔══════════════════════════════════════════════════════╗\x1b[0m\n` +
          `\x1b[32m║  NERV // MAGI AGENT TERMINAL — TASK INIT             ║\x1b[0m\n` +
          `\x1b[32m║  特務機関NERV // PATTERN: BLUE                       ║\x1b[0m\n` +
          `\x1b[32m╚══════════════════════════════════════════════════════╝\x1b[0m\n\n`
      );

      stream.on("event", (e) => {
        if (e.type === "token") {
          process.stdout.write(e.content);
        } else if (e.type === "done") {
          process.stdout.write(
            `\n\x1b[32m[TASK COMPLETE — PATTERN GREEN]\x1b[0m\n`
          );
          if (opts.output === "json") {
            process.stdout.write(JSON.stringify(e.output, null, 2) + "\n");
          } else if (e.output["result.md"]) {
            process.stdout.write(
              `\n\x1b[32m── /output/result.md ──\x1b[0m\n${e.output["result.md"]}\n`
            );
          }
        } else if (e.type === "error") {
          process.stderr.write(`\x1b[31m[CONDITION RED — ${e.error}]\x1b[0m\n`);
        }
      });
    } else {
      stream.on("event", (e) => {
        if (e.type === "token") process.stdout.write(e.content);
        if (e.type === "done" && opts.output === "json") {
          process.stdout.write(JSON.stringify(e.output, null, 2) + "\n");
        }
      });
    }

    const abort = new AbortController();
    process.on("SIGINT", () => {
      process.stderr.write("\n\x1b[31m[CONDITION RED — SIGINT]\x1b[0m\n");
      abort.abort();
    });

    try {
      const result = await runTask({
        prompt,
        files,
        network,
        stream,
        signal: abort.signal,
      });
      process.exit(result.done ? 0 : 1);
    } catch (err) {
      process.stderr.write(
        `\x1b[31m[CONDITION RED]\x1b[0m ${err instanceof Error ? err.message : String(err)}\n`
      );
      process.exit(1);
    }
  });

program.parseAsync(process.argv).catch((err) => {
  process.stderr.write(`[NERV] Fatal: ${err.message}\n`);
  process.exit(1);
});
