import Anthropic from "@anthropic-ai/sdk";
import { createSandbox } from "./sandbox.js";
import { TaskStream } from "./streaming.js";

/** Normalize bare \n → \r\n for xterm.js rendering */
function term(text: string): string {
  return text.replace(/\r?\n/g, "\r\n");
}

const SYSTEM_PROMPT = `You are an autonomous shell agent running inside a secure sandbox.

ENVIRONMENT:
- You have full control of a bash shell. Use it to accomplish the task.
- /input/   — read-only. Task files are here. Start by reading task.md if present.
- /work/    — read-write. Your scratchpad for intermediate work.
- /output/  — read-write. Write your primary deliverable here.
- /data/    — read-only. Corpus data if available.

STYLE — work like a human at a terminal:
- One command at a time. Read the output. Decide the next step.
- Explore and verify data shapes BEFORE writing analysis code.
- Prefer many small focused commands over large upfront scripts.
- Write scripts to /work/ and test with a sample before running on full data.
- Never write a 100-line script when five 5-line scripts will do.

SQLITE (bash CLI):
- The filesystem is in-memory. sqlite3 CANNOT open host files — only /input/ /work/ /output/ /data/.
- For persistent state across multiple queries: use sqlite3 /work/data.db
  Example: sqlite3 /work/data.db "CREATE TABLE t(x); INSERT INTO t VALUES(1);"
           sqlite3 /work/data.db "SELECT * FROM t;"   ← state is preserved
- For one-off ephemeral queries: sqlite3 :memory: "SELECT ..."
- NEVER use bare filenames like sqlite3 myfile.db — always use full paths starting with /

PYTHON:
- python3 is available (CPython 3.13 WASM). Standard library ONLY — no pip, no third-party packages.
- Available stdlib: csv, json, statistics, pathlib, re, datetime, collections, itertools, math, zipfile, io, xml.etree.ElementTree, etc.
- DO NOT attempt: import sqlite3 (C extension — not available), import openpyxl, import pandas, import numpy, pip install.
  Use the bash sqlite3 CLI command for all database work instead.
- A helper script is pre-loaded at /work/nerv_helpers.py with common utilities.
  Load it with: exec(open('/work/nerv_helpers.py').read())
  Then use: read_csv('/input/data.csv')  summarise(values, 'label')  write_json(data)  write_csv(rows, '/output/out.csv')
- Excel/spreadsheet files (.xlsx/.xls) are AUTO-CONVERTED to CSV in /input/ alongside the original.
  If you see data.xlsx in /input/, also check for data.csv — it will be there. Use the CSV.
- ALWAYS write Python scripts to /work/script.py — NEVER use python3 -c "..." or heredocs for Python.
  Multi-line inline Python causes indentation errors. Write to file, then run: python3 /work/script.py
- Indent class methods with 4 spaces. Never leave an empty class/function body — use pass.
- Syntax-check before running: python3 -c "import ast; ast.parse(open('/work/script.py').read()); print('OK')"

PROTOCOL:
- Think step by step. Run commands. Read results. Iterate.
- Write your primary output to /output/result.md
- If you produce structured data, also write /output/data.json
- Signal completion with: echo "TASK COMPLETE" and stop calling tools.

OPERATOR NOTES:
- If you receive [OPERATOR NOTE] messages, acknowledge and adapt your approach.
- Notes are advisory. Complete in-flight commands before pivoting.
- Respond with: "// OPERATOR NOTE RECEIVED: <brief ack>" as a comment in your next command.

CONDITION CODES:
- PATTERN BLUE  — running normally
- PATTERN GREEN — task complete
- PATTERN RED   — error / abort`;

const BASH_TOOL: Anthropic.Tool = {
  name: "bash",
  description:
    "Execute a bash command in the secure sandbox. The filesystem persists across calls. Output is streamed to the observer terminal.",
  input_schema: {
    type: "object" as const,
    properties: {
      command: {
        type: "string",
        description: "The bash command to execute",
      },
    },
    required: ["command"],
  },
};

export interface RunConfig {
  prompt: string;
  files?: Record<string, string | Buffer | Uint8Array>;
  dataMount?: string;
  network?: { allowedUrlPrefixes: string[] };
  stream?: TaskStream;
  /** Called for each text token from Claude's reasoning */
  onToken?: (text: string) => void;
  /** Called when Claude executes a command */
  onCommand?: (cmd: string) => void;
  /** AbortSignal for hard-abort */
  signal?: AbortSignal;
}

export interface RunResult {
  output: Record<string, string>;
  done: boolean;
}

export async function runTask(config: RunConfig): Promise<RunResult> {
  const client = new Anthropic();
  const stream = config.stream ?? new TaskStream();

  // Wire optional callbacks into stream
  if (config.onToken) {
    stream.on("event", (e) => {
      if (e.type === "token") config.onToken!(e.content);
    });
  }
  if (config.onCommand) {
    stream.on("event", (e) => {
      if (e.type === "command") config.onCommand!(e.command);
    });
  }

  const { bash, readOutput, destroy } = await createSandbox({
    inputFiles: config.files,
    dataMount: config.dataMount,
    network: config.network,
  });

  // Inject the prompt as task.md if no task.md provided
  if (!config.files?.["task.md"]) {
    await bash.exec(`mkdir -p /input && cat > /input/task.md << 'NERV_EOF'\n${config.prompt}\nNERV_EOF`);
  }

  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content: config.prompt,
    },
  ];

  let done = false;
  let stepCount = 0;
  const MAX_STEPS = 50;

  try {
    while (!done && stepCount < MAX_STEPS) {
      if (config.signal?.aborted || stream.aborted) {
        stream.abort("Hard abort received");
        break;
      }

      // Safety net: if the last message is an assistant message with unmatched
      // tool_use blocks (e.g. due to an abort mid-loop), patch the history before
      // the next API call or we'll get a 400 from the Anthropic API.
      if (messages.length > 0) {
        const last = messages[messages.length - 1];
        if (last.role === "assistant" && Array.isArray(last.content)) {
          const orphaned = (last.content as Anthropic.ContentBlock[])
            .filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use")
            .map((b) => ({
              type: "tool_result" as const,
              tool_use_id: b.id,
              content: "[interrupted]",
            }));
          if (orphaned.length > 0) {
            console.error("[MAGI] Patching orphaned tool_use blocks in message history");
            messages.push({ role: "user", content: orphaned });
          }
        }
      }

      stepCount++;

      stream.thinking();
      const response = await client.messages.create({
        model: "claude-opus-4-6",
        max_tokens: 32768,
        system: SYSTEM_PROMPT,
        tools: [BASH_TOOL],
        messages,
      });

      // Collect assistant message content
      const assistantContent: Anthropic.ContentBlock[] = [];

      for (const block of response.content) {
        assistantContent.push(block);

        if (block.type === "text" && block.text) {
          // Stream Claude's reasoning text
          stream.write(term(`\x1b[2m${block.text}\x1b[0m\n`));
        }
      }

      messages.push({ role: "assistant", content: assistantContent });

      if (response.stop_reason === "end_turn") {
        done = true;
        break;
      }

      // Handle stop reasons other than end_turn / tool_use
      if (response.stop_reason !== "tool_use") {
        const orphaned = assistantContent
          .filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");

        if (orphaned.length > 0) {
          // Truncated mid-tool-call — can't recover, patch history and stop
          stream.write(
            term(`\x1b[33m[MAGI — response truncated mid-tool-call, stopping]\x1b[0m\n`)
          );
          messages.push({
            role: "user",
            content: orphaned.map((b) => ({
              type: "tool_result" as const,
              tool_use_id: b.id,
              content: "[truncated — max_tokens]",
            })),
          });
          done = true;
          break;
        }

        if (response.stop_reason === "max_tokens") {
          // Pure text truncation — nudge Claude to continue
          stream.write(term(`\x1b[2m[↩ continuing...]\x1b[0m\n`));
          messages.push({ role: "user", content: "Continue." });
          // loop continues — no break
        } else {
          // Unexpected stop reason
          stream.write(
            term(`\x1b[33m[MAGI — stop_reason: ${response.stop_reason}]\x1b[0m\n`)
          );
          done = true;
          break;
        }
      }

      if (response.stop_reason === "tool_use") {
        const toolResults: Anthropic.ToolResultBlockParam[] = [];

        for (const block of response.content) {
          if (block.type !== "tool_use") continue;

          if (block.name === "bash") {
            const input = block.input as { command: string };
            const cmd = input.command;

            // Emit command event — client handles display with decoder animation
            stream.command(cmd);

            // Execute in sandbox
            let stdout = "";
            let stderr = "";
            let exitCode = 0;

            try {
              const result = await bash.exec(cmd, {
                signal: config.signal,
              });
              stdout = result.stdout ?? "";
              stderr = result.stderr ?? "";
              exitCode = result.exitCode ?? 0;
            } catch (err: unknown) {
              stderr = err instanceof Error ? err.message : String(err);
              exitCode = 1;
            }

            // Stream output
            if (stdout) {
              stream.write(term(`\x1b[32m${stdout}\x1b[0m`));
            }
            if (stderr) {
              stream.write(term(`\x1b[31m${stderr}\x1b[0m`));
            }

            // Build tool result, injecting any pending side-channel notes
            let resultContent = "";
            if (stdout) resultContent += stdout;
            if (stderr) resultContent += `\nSTDERR: ${stderr}`;
            if (exitCode !== 0) resultContent += `\nExit code: ${exitCode}`;

            // Side channel injection at tool_result boundary
            const sideNote = stream.drainSideChannel();
            if (sideNote) {
              resultContent += `\n\n${sideNote}`;
              stream.write(
                term(`\x1b[36m\n[OPERATOR NOTE INJECTED INTO CONTEXT]\x1b[0m\n`)
              );
            }

            toolResults.push({
              type: "tool_result",
              tool_use_id: block.id,
              content: resultContent || "(no output)",
            });
          }
        }

        messages.push({ role: "user", content: toolResults });
      }
    }

    if (stepCount >= MAX_STEPS) {
      stream.write(
        term(`\x1b[31m\n[MAGI WARNING — MAX STEPS REACHED: ${MAX_STEPS}]\x1b[0m\n`)
      );
    }

    const output = await readOutput();
    stream.complete(output);
    return { output, done };
  } finally {
    destroy();
  }
}
