import path from "path";
import os from "os";
import fs from "fs/promises";

const SESSIONS_DIR = path.join(os.homedir(), ".nerv", "sessions");

async function ensureSessionDir(sessionId: string): Promise<string> {
  const dir = path.join(SESSIONS_DIR, sessionId);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/** Load a previously persisted /work/data.db for this session, or null if none. */
export async function loadSessionDb(sessionId: string): Promise<Buffer | null> {
  try {
    const dir = await ensureSessionDir(sessionId);
    return await fs.readFile(path.join(dir, "data.db"));
  } catch {
    return null;
  }
}

/** Persist the in-sandbox /work/data.db bytes to the host filesystem. */
export async function saveSessionDb(
  sessionId: string,
  data: Buffer
): Promise<void> {
  const dir = await ensureSessionDir(sessionId);
  await fs.writeFile(path.join(dir, "data.db"), data);
}

/** List all known session IDs (directories under ~/.nerv/sessions/). */
export async function listSessions(): Promise<string[]> {
  try {
    await fs.mkdir(SESSIONS_DIR, { recursive: true });
    const entries = await fs.readdir(SESSIONS_DIR, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}
