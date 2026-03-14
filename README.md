# NERV // MAGI AGENT TERMINAL

> *"All MAGI vote: PROCEED"*

A Claude-powered autonomous agent terminal with a NERV / Evangelion aesthetic. Drop files in, give a task, watch the agent work in a phosphor-green xterm.js terminal.

![NERV Terminal](https://img.shields.io/badge/MAGI-ONLINE-00ff88?style=flat-square&labelColor=000000)
![Model](https://img.shields.io/badge/model-claude--haiku--4--5-ffaa00?style=flat-square&labelColor=000000)
![License](https://img.shields.io/badge/license-MIT-0088ff?style=flat-square&labelColor=000000)

---

## Features

- **In-memory sandboxed bash** via [just-bash](https://github.com/nicholasgasior/just-bash) — no Docker, no host access
- **Real-time streaming** — text tokens appear as Claude generates them
- **Phosphor spinner** during LLM processing, amber `$ cmd` on tool calls
- **File uploads** — drag and drop; `.xlsx`/`.xls` auto-converted to CSV via SheetJS
- **Python WASM** (CPython 3.13) with stdlib helpers pre-loaded at `/work/nerv_helpers.py`
- **Stateful sqlite3** via bash CLI, persistent across queries within a session
- **Sandbox context injection** — file listing, CSV headers, DB schema prepended to turn 0 (no discovery turns wasted)
- **Prompt caching** — system prompt, tools, and initial message cached; ~90% cost reduction on multi-turn tasks
- **Side-channel operator notes** — inject instructions mid-run via WebSocket
- **Output file panel** — per-file download buttons + Download All appear on task completion
- **CLI** — run tasks from the terminal without the browser UI

---

## Stack

| Layer | Tech |
|---|---|
| Agent loop | `@anthropic-ai/sdk` streaming, `claude-haiku-4-5` |
| Sandbox | `just-bash` MountableFs + InMemoryFs |
| Server | Fastify v5, `@fastify/websocket`, SSE |
| Terminal UI | xterm.js 5, FitAddon |
| Spreadsheets | SheetJS (xlsx) |
| CLI | Commander |
| Runtime | Node.js + tsx (ESM, NodeNext) |

---

## Quick Start

```bash
# 1. Install
npm install

# 2. Set API key
export ANTHROPIC_API_KEY=sk-ant-...

# 3. Start server
npx tsx src/server.ts

# 4. Open browser
open http://localhost:3000
```

---

## CLI

```bash
# Basic task
npx tsx src/cli.ts "summarise the data in report.csv" --file report.csv

# With multiple files
npx tsx src/cli.ts "analyse this" --file data.xlsx --file notes.md

# Shorthand (auto-detects no subcommand)
npx tsx src/cli.ts "what is 2+2"
```

---

## Architecture

```
browser / CLI
     │
     ▼
Fastify (POST /run → SSE,  WS /ws/:taskId)
     │
     ▼
runner.ts  ──  TaskStream (EventEmitter)
     │               │
     │         SSE fan-out ──► xterm.js terminal
     │         WS  fan-out ──► side-channel
     ▼
createSandbox()
  ├─ MountableFs  /input  /work  /output
  ├─ InMemoryFs   per mount
  ├─ xlsx → CSV   (SheetJS, server-side)
  └─ Bash (just-bash)
       ├─ python3  (CPython 3.13 WASM)
       └─ sqlite3  (bash CLI, stateful via /work/data.db)
```

### Event flow

```
stream.thinking()          →  spinner animates (LLM processing)
stream.write(token)        →  spinner clears, text appears
stream.command(cmd)        →  spinner clears, "$ cmd" in amber
stream.complete(output)    →  PATTERN GREEN box + download panel
stream.abort(reason)       →  CONDITION RED
```

### Prompt caching

Three `cache_control: ephemeral` breakpoints per request:

| Breakpoint | Tokens | Cached after |
|---|---|---|
| System prompt | ~800 | Turn 1 |
| BASH_TOOL definition | ~100 | Turn 1 |
| Initial message (context + task) | varies | Turn 1 |

Cache hits cost 10% of normal input price. On a 20-turn task the system prompt alone saves ~14K tokens.

---

## Sandbox layout

```
/input/   read-only   task files (uploaded or CLI)
/work/    read-write  scripts, intermediate data, data.db
/output/  read-write  deliverables — downloaded via UI panel
/data/    read-only   optional corpus mount
```

---

## Python helpers (`/work/nerv_helpers.py`)

Pre-loaded each run. Load with `exec(open('/work/nerv_helpers.py').read())`.

| Function | Description |
|---|---|
| `read_csv(path)` | Returns list of dicts from CSV |
| `summarise(values, label)` | n / min / max / mean / stdev |
| `write_json(data, path)` | Writes to `/output/data.json` |
| `write_csv(rows, path)` | Writes CSV from list of dicts |

> **Note:** `import sqlite3` is not available in CPython WASM. Use the `sqlite3` bash CLI instead.

---

## Configuration

| Env var | Default | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | required | Anthropic API key |
| `PORT` | `3000` | HTTP server port |

To switch models, edit `model:` in `src/runner.ts`. Current default: `claude-haiku-4-5-20251001`. For production quality use `claude-opus-4-6`.

---

## Known limitations

- Python stdlib only — no pip, no numpy/pandas
- `import sqlite3` not available (CPython WASM missing C extension) — use bash `sqlite3` CLI
- Network sandbox: outbound requests restricted to configured allow-list
- just-bash sqlite3 worker patched in-place — `npm install` will overwrite it (fix: add `postinstall` script)

---

*特務機関NERV // GEHIRN BIOLOGIC LAB*
