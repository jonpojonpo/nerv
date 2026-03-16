import Fastify from "fastify";
import fastifyWebSocket from "@fastify/websocket";
import { randomUUID } from "crypto";
import { runTask } from "./runner.js";
import type { SessionState } from "./runner.js";
import { TaskStream } from "./streaming.js";
import type { TaskEvent } from "./streaming.js";
import { loadSessionDb, saveSessionDb } from "./sessions.js";
import { createSandbox } from "./sandbox.js";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Prevent unhandled rejections / uncaught exceptions from crashing the server.
process.on("unhandledRejection", (reason) => {
  console.error("[MAGI] Unhandled rejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[MAGI] Uncaught exception:", err);
});

const app = Fastify({ logger: false });

// ── Active in-flight tasks: taskId → { stream, abort } ───────────────────────
const tasks = new Map<
  string,
  { stream: TaskStream; abort: AbortController }
>();

// ── Long-lived sessions: sessionId → { state, lastActive } ───────────────────
// Sessions survive task completion so the sandbox (including /work/data.db)
// stays alive for chat continuation.
interface LiveSession {
  state: SessionState;
  lastActive: Date;
}
const sessions = new Map<string, LiveSession>();

// Cleanup idle sessions every 10 minutes (idle > 1 hour)
setInterval(() => {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const [id, sess] of sessions) {
    if (sess.lastActive.getTime() < cutoff) {
      sess.state.destroy();
      sessions.delete(id);
      console.log(`[MAGI] Session ${id} expired and destroyed`);
    }
  }
}, 10 * 60 * 1000);

app.register(fastifyWebSocket);

// Serve static client files
app.get("/", async (_req, reply) => {
  const html = fs.readFileSync(
    path.join(__dirname, "../client/terminal.html"),
    "utf-8"
  );
  reply.type("text/html").send(html);
});

app.get("/nerv.css", async (_req, reply) => {
  const css = fs.readFileSync(
    path.join(__dirname, "../client/nerv.css"),
    "utf-8"
  );
  reply.type("text/css").send(css);
});

app.get("/terminal.js", async (_req, reply) => {
  reply.type("application/javascript").send(`// terminal.ts compiled bundle`);
});

/**
 * Helper: run a task on an SSE stream and keep session alive after completion.
 * Saves /work/data.db to host FS after each run for cross-session persistence.
 */
async function runTaskSse(opts: {
  req: import("fastify").FastifyRequest;
  reply: import("fastify").FastifyReply;
  prompt: string;
  files?: Record<string, string | Buffer>;
  network?: { allowedUrlPrefixes: string[] };
  sessionId: string;
  existingSession?: SessionState;
}): Promise<void> {
  const { req, reply, prompt, files, network, sessionId, existingSession } = opts;

  const taskId = randomUUID();
  const stream = new TaskStream();
  const abort = new AbortController();

  tasks.set(taskId, { stream, abort });

  reply.hijack();
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Task-Id": taskId,
    "X-Session-Id": sessionId,
  });

  const sendEvent = (event: TaskEvent) => {
    if (!reply.raw.writableEnded) {
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    }
  };

  stream.on("event", sendEvent);

  await new Promise<void>((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      stream.off("event", sendEvent);
      tasks.delete(taskId);
      if (!reply.raw.writableEnded) reply.raw.end();
      resolve();
    };

    stream.once("complete", done);
    stream.once("abort", done);

    const socket = req.raw.socket;
    if (socket) {
      socket.once("close", () => {
        abort.abort("client disconnected");
        done();
      });
    }

    runTask({
      prompt,
      files,
      network,
      stream,
      signal: abort.signal,
      session: existingSession,
    })
      .then(async (result) => {
        // Keep session alive for chat continuation
        sessions.set(sessionId, {
          state: result.session,
          lastActive: new Date(),
        });

        // Persist /work/data.db to host FS
        const dbBytes = await result.session.readWorkFile("data.db");
        if (dbBytes && dbBytes.length > 0) {
          await saveSessionDb(sessionId, dbBytes).catch((err) =>
            console.error("[MAGI] Failed to save session DB:", err)
          );
          console.log(
            `[MAGI] Session ${sessionId}: persisted data.db (${dbBytes.length} bytes)`
          );
        }
      })
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[MAGI] runTask error:", err);
        stream.abort(msg);
      });
  });
}

/**
 * POST /run — start a new task.
 *
 * Accepts optional { sessionId } to restore a previous session's SQLite DB.
 * Returns X-Task-Id and X-Session-Id headers.
 */
app.post("/run", async (req, reply) => {
  const body = req.body as {
    prompt?: string;
    files?: Record<string, string | { data: string; encoding: "base64" }>;
    network?: { allowedUrlPrefixes: string[] };
    sessionId?: string;
  };

  if (!body?.prompt) {
    return reply.code(400).send({ error: "prompt required" });
  }

  const sessionId = body.sessionId ?? randomUUID();

  // Decode files
  const decodedFiles: Record<string, string | Buffer> = {};
  for (const [name, content] of Object.entries(body.files ?? {})) {
    if (typeof content === "object" && content.encoding === "base64") {
      decodedFiles[name] = Buffer.from(content.data, "base64");
    } else {
      decodedFiles[name] = content as string;
    }
  }

  // Check for an existing live session first
  let existingSession = sessions.get(sessionId)?.state;

  // If no live session but a persisted DB exists for this sessionId, create a
  // new sandbox pre-seeded with the saved DB.
  if (!existingSession) {
    const persistedDb = await loadSessionDb(sessionId);
    if (persistedDb) {
      console.log(
        `[MAGI] Session ${sessionId}: restoring data.db (${persistedDb.length} bytes)`
      );
      const sandbox = await createSandbox({
        inputFiles: decodedFiles,
        network: body.network,
        persistedDb,
      });
      // Inject task.md so discovery works
      await sandbox.bash.exec(
        `mkdir -p /input && cat > /input/task.md << 'NERV_EOF'\n${body.prompt}\nNERV_EOF`
      );
      existingSession = {
        bash: sandbox.bash,
        readOutput: sandbox.readOutput,
        readWorkFile: sandbox.readWorkFile,
        destroy: sandbox.destroy,
        messages: [],
      };
    }
  }

  await runTaskSse({
    req,
    reply,
    prompt: body.prompt,
    files: existingSession ? undefined : decodedFiles,
    network: body.network,
    sessionId,
    existingSession,
  });
});

/**
 * POST /chat/:sessionId — continue a conversation in an existing session.
 *
 * The sandbox and full message history are preserved. /work/data.db is intact.
 * Body: { message: string }
 */
app.post("/chat/:sessionId", async (req, reply) => {
  const { sessionId } = req.params as { sessionId: string };
  const body = req.body as { message?: string };

  if (!body?.message) {
    return reply.code(400).send({ error: "message required" });
  }

  const sess = sessions.get(sessionId);
  if (!sess) {
    return reply.code(404).send({ error: "session not found or expired — start a new task first" });
  }

  sess.lastActive = new Date();

  await runTaskSse({
    req,
    reply,
    prompt: body.message,
    sessionId,
    existingSession: sess.state,
  });
});

/**
 * DELETE /run/:taskId — hard abort
 */
app.delete("/run/:taskId", async (req, reply) => {
  const { taskId } = req.params as { taskId: string };
  const task = tasks.get(taskId);
  if (!task) {
    return reply.code(404).send({ error: "task not found" });
  }
  task.abort.abort("operator abort");
  task.stream.abort("CONDITION RED — OPERATOR ABORT");
  tasks.delete(taskId);
  return reply.send({ ok: true, taskId });
});

/**
 * DELETE /session/:sessionId — explicitly destroy a session
 */
app.delete("/session/:sessionId", async (req, reply) => {
  const { sessionId } = req.params as { sessionId: string };
  const sess = sessions.get(sessionId);
  if (!sess) {
    return reply.code(404).send({ error: "session not found" });
  }
  sess.state.destroy();
  sessions.delete(sessionId);
  return reply.send({ ok: true, sessionId });
});

/**
 * WebSocket /ws/:taskId — raw terminal bytes for xterm.js
 *
 * Also accepts { type: "side_channel", message } from client.
 */
app.register(async (fastify) => {
  fastify.get(
    "/ws/:taskId",
    { websocket: true },
    (socket, req) => {
      const { taskId } = req.params as { taskId: string };
      const task = tasks.get(taskId);

      if (!task) {
        socket.send(
          JSON.stringify({ type: "error", error: "task not found" })
        );
        socket.close();
        return;
      }

      // Forward all events to websocket
      const onEvent = (event: TaskEvent) => {
        if (socket.readyState === socket.OPEN) {
          socket.send(JSON.stringify(event));
        }
      };
      task.stream.on("event", onEvent);

      // Receive side-channel from browser
      socket.on("message", (raw: Buffer) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.type === "side_channel" && typeof msg.message === "string") {
            task.stream.sideChannel(msg.message);
          }
        } catch {
          // ignore malformed messages
        }
      });

      socket.on("close", () => {
        task.stream.off("event", onEvent);
      });
    }
  );
});

/**
 * POST /side-channel/:taskId — inject side channel via HTTP (fallback)
 */
app.post("/side-channel/:taskId", async (req, reply) => {
  const { taskId } = req.params as { taskId: string };
  const body = req.body as { message?: string };
  const task = tasks.get(taskId);

  if (!task) {
    return reply.code(404).send({ error: "task not found" });
  }
  if (!body?.message) {
    return reply.code(400).send({ error: "message required" });
  }

  task.stream.sideChannel(body.message);
  return reply.send({ ok: true });
});

const PORT = parseInt(process.env.PORT ?? "3000", 10);
const HOST = process.env.HOST ?? "0.0.0.0";

app.listen({ port: PORT, host: HOST }).then(() => {
  console.log(`\x1b[32m[MAGI ONLINE] NERV server running at http://localhost:${PORT}\x1b[0m`);
  console.log(`\x1b[32m[MAGI] POST /run to start a task\x1b[0m`);
  console.log(`\x1b[32m[MAGI] POST /chat/:sessionId to continue\x1b[0m`);
  console.log(`\x1b[32m[MAGI] WebSocket /ws/:taskId for xterm.js\x1b[0m`);
});

export default app;
