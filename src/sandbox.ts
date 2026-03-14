import { Bash, InMemoryFs, MountableFs } from "just-bash";
import type { CustomCommand } from "just-bash";
import * as XLSX from "xlsx";
import { srgCommand } from "./commands/srg.js";
import { delegateCommand } from "./commands/delegate.js";

export interface SandboxConfig {
  /** filename → content (string) or raw bytes (Buffer/Uint8Array), injected into /input/ */
  inputFiles?: Record<string, string | Buffer | Uint8Array>;
  /** host path for /data/ corpus (future: OverlayFs) */
  dataMount?: string;
  /** network allow-list for curl */
  network?: { allowedUrlPrefixes: string[] };
}

export interface SandboxResult {
  bash: Bash;
  readOutput: () => Promise<Record<string, string>>;
  destroy: () => void;
}

// ── Python bootstrap injected into /work/nerv_helpers.py ───────────────────
// Pure stdlib utilities. The agent is told about this file in the system prompt.
const PYTHON_HELPERS = `"""
nerv_helpers.py — stdlib-only utilities pre-loaded into every sandbox session.
Import with: from nerv_helpers import read_csv, read_json, summarise
"""
import csv, json, statistics, pathlib, sys

def read_csv(path, delimiter=','):
    """Read a CSV file, return list of dicts."""
    with open(path, newline='', encoding='utf-8-sig') as f:
        return list(csv.DictReader(f, delimiter=delimiter))

def read_json(path):
    """Read a JSON file, return parsed object."""
    return json.loads(pathlib.Path(path).read_text())

def summarise(values, label='value'):
    """Print basic stats for a numeric list."""
    v = [float(x) for x in values if x not in (None, '', 'N/A')]
    if not v:
        print(f"{label}: no data")
        return
    stdev = statistics.stdev(v) if len(v) > 1 else 0
    print(f"{label}: n={len(v)}  min={min(v):.4g}  max={max(v):.4g}  "
          f"mean={statistics.mean(v):.4g}  stdev={stdev:.4g}")

def write_json(data, path='/output/data.json'):
    """Write data as JSON to path."""
    pathlib.Path(path).write_text(json.dumps(data, indent=2, default=str))
    print(f"Written to {path}")

def write_csv(rows, path, fieldnames=None):
    """Write list-of-dicts to CSV."""
    if not rows:
        print("write_csv: no rows"); return
    fieldnames = fieldnames or list(rows[0].keys())
    with open(path, 'w', newline='') as f:
        w = csv.DictWriter(f, fieldnames=fieldnames)
        w.writeheader(); w.writerows(rows)
    print(f"Written {len(rows)} rows to {path}")
`;

// ── Excel / spreadsheet conversion ────────────────────────────────────────
const SPREADSHEET_EXTS = new Set([".xlsx", ".xls", ".xlsm", ".xlsb", ".ods", ".csv"]);

function convertSpreadsheet(name: string, data: Buffer | Uint8Array): Record<string, string> {
  const workbook = XLSX.read(data, { type: "buffer", cellDates: true });
  const out: Record<string, string> = {};
  const base = name.replace(/\.[^.]+$/, "");

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const csv = XLSX.utils.sheet_to_csv(sheet, { blankrows: false });
    // single sheet: keep original stem; multi-sheet: append sheet name
    const csvName =
      workbook.SheetNames.length === 1
        ? `${base}.csv`
        : `${base}_${sheetName.replace(/[^a-z0-9_-]/gi, "_")}.csv`;
    out[csvName] = csv;
  }
  return out;
}

/**
 * Create a fresh sandbox. Async because InMemoryFs.writeFile is async.
 *
 * Filesystem layout:
 *   /input/   read-only  — task files injected at start
 *   /work/    read-write — agent scratchpad (cwd) + nerv_helpers.py
 *   /output/  read-write — harvested after completion
 *   /data/    read-only  — corpus (empty until Phase 04)
 */
export async function createSandbox(
  config: SandboxConfig
): Promise<SandboxResult> {
  const mountableFs = new MountableFs();

  // /input/ — InMemoryFs pre-populated with task files.
  // Spreadsheets are auto-converted to CSV alongside the original.
  const inputFs = new InMemoryFs();
  if (config.inputFiles) {
    for (const [name, content] of Object.entries(config.inputFiles)) {
      const stripped = name.replace(/^\//, "");
      const ext = "." + stripped.split(".").pop()!.toLowerCase();

      if (SPREADSHEET_EXTS.has(ext) && ext !== ".csv" && (Buffer.isBuffer(content) || content instanceof Uint8Array)) {
        // Inject original binary
        await inputFs.writeFile(`/${stripped}`, content as Buffer);
        // Also inject converted CSV(s) so the agent can use them without openpyxl
        try {
          const csvFiles = convertSpreadsheet(stripped, content as Buffer);
          for (const [csvName, csvData] of Object.entries(csvFiles)) {
            await inputFs.writeFile(`/${csvName}`, csvData);
          }
        } catch (err) {
          console.error(`[MAGI] Failed to convert ${stripped} to CSV:`, err);
          // Original binary still available; agent will need to handle it directly
        }
      } else {
        await inputFs.writeFile(
          `/${stripped}`,
          typeof content === "string" ? content : Buffer.from(content)
        );
      }
    }
  }
  mountableFs.mount("/input", inputFs);

  // /work/ — rw scratchpad + pre-seeded Python helpers
  const workFs = new InMemoryFs();
  await workFs.writeFile("/nerv_helpers.py", PYTHON_HELPERS);
  mountableFs.mount("/work", workFs);

  // /output/ — rw results
  const outputFs = new InMemoryFs();
  mountableFs.mount("/output", outputFs);

  // /data/ — ro corpus (empty until Phase 04)
  const dataFs = new InMemoryFs();
  mountableFs.mount("/data", dataFs);

  const customCommands: CustomCommand[] = [srgCommand, delegateCommand];

  const bash = new Bash({
    fs: mountableFs,
    cwd: "/work",
    env: { PYTHONPATH: "/work" },
    customCommands,
    python: true,
    ...(config.network
      ? {
          network: {
            allowedUrlPrefixes: config.network.allowedUrlPrefixes,
            allowedMethods: ["GET", "POST"],
          },
        }
      : {}),
  });

  const readOutput = async (): Promise<Record<string, string>> => {
    const result: Record<string, string> = {};
    try {
      const entries = await outputFs.readdir("/");
      for (const entry of entries) {
        try {
          const content = await outputFs.readFile(`/${entry}`, "utf-8");
          result[entry] = content;
        } catch {
          // skip unreadable entries (directories, etc.)
        }
      }
    } catch {
      // /output/ may be empty
    }
    return result;
  };

  const destroy = () => {
    // just-bash is in-memory; GC handles cleanup.
  };

  return { bash, readOutput, destroy };
}
