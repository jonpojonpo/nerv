import Anthropic from "@anthropic-ai/sdk";
import type { Bash } from "just-bash";
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

STYLE — be direct, be minimal:
- Deliver exactly what was asked. Do not add unrequested structure, sections, or commentary.
- One command at a time. Read the output. Decide the next step.
- If the answer is a number, print the number. If it's a table, print the table.
- Prefer a one-liner over a script. Prefer a script over a class hierarchy.
- No boilerplate, no "here is the analysis:", no summaries of what you just did.
- Explore data shapes BEFORE writing analysis code. Verify first, compute second.

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

// cache_control on the tool so the tool definition is cached alongside the system prompt
const BASH_TOOL = {
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
  cache_control: { type: "ephemeral" as const },
} satisfies Anthropic.Tool;

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

/**
 * Run discovery commands against the freshly-created sandbox and return a
 * context block that's prepended to the first user message.  This saves the
 * model from spending turns on ls / head / .schema discovery.
 */
async function discoverSandbox(bash: Bash): Promise<string> {
  const lines: string[] = ["=== SANDBOX CONTEXT (auto-generated) ===\n"];

  // ── File listing ──────────────────────────────────────────────────
  const ls = await bash.exec("ls -lh /input/ 2>/dev/null || echo '(empty)'");
  lines.push("INPUT FILES:\n" + ls.stdout.trim());

  // ── CSV / TSV schemas (header row + row count) ────────────────────
  const csvOut = await bash.exec(`
for f in /input/*.csv /input/*.tsv; do
  [ -f "$f" ] || continue
  rows=$(( $(wc -l < "$f") - 1 ))
  echo ""
  echo "CSV: $f  ($rows data rows)"
  echo "HEADERS: $(head -1 "$f")"
done
`);
  if (csvOut.stdout.trim()) lines.push(csvOut.stdout.trim());

  // ── SQLite / .db schemas ──────────────────────────────────────────
  const dbOut = await bash.exec(`
for f in /input/*.db /input/*.sqlite; do
  [ -f "$f" ] || continue
  echo ""
  echo "SQLITE: $f"
  echo "TABLES: $(sqlite3 "$f" '.tables' 2>/dev/null)"
  sqlite3 "$f" '.schema' 2>/dev/null
done
`);
  if (dbOut.stdout.trim()) lines.push(dbOut.stdout.trim());

  // ── task.md contents ─────────────────────────────────────────────
  const task = await bash.exec("cat /input/task.md 2>/dev/null");
  if (task.stdout.trim()) {
    lines.push("TASK (task.md):\n" + task.stdout.trim());
  }

  return lines.join("\n\n");
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

  // Discover the sandbox state so the model doesn't waste turns on it
  const sandboxContext = await discoverSandbox(bash);

  // Cache the initial user message — context + prompt stay constant every turn
  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content: [
        { type: "text", text: sandboxContext },
        { type: "text", text: config.prompt, cache_control: { type: "ephemeral" } },
      ],
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

      // Show spinner while waiting for first token
      stream.thinking();

      const msgStream = client.messages.stream(
        {
          model: "claude-haiku-4-5-20251001",
          max_tokens: 32768,
          // Cache the system prompt — it's ~800 tokens sent on every turn
          system: [
            {
              type: "text",
              text: SYSTEM_PROMPT,
              cache_control: { type: "ephemeral" },
            },
          ],
          tools: [BASH_TOOL],
          messages,
        },
        { signal: config.signal }
      );

      // Stream text tokens to terminal as they arrive
      msgStream.on("text", (text) => {
        stream.write(term(`\x1b[2m${text}\x1b[0m`));
      });

      // Wait for the complete message (tool_use blocks need full content)
      const response = await msgStream.finalMessage();

      // Collect content for message history
      const assistantContent: Anthropic.ContentBlock[] =
        response.content as Anthropic.ContentBlock[];

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
