import Fastify from "fastify";
import fastifyWebSocket from "@fastify/websocket";
import { randomUUID } from "crypto";
import { runTask } from "./runner.js";
import { TaskStream } from "./streaming.js";
import type { TaskEvent } from "./streaming.js";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Prevent unhandled rejections / uncaught exceptions from crashing the server.
// Log them so we can diagnose, but keep the process alive so other tasks continue.
process.on("unhandledRejection", (reason, promise) => {
  console.error("[MAGI] Unhandled rejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[MAGI] Uncaught exception:", err);
});

const app = Fastify({ logger: false });

// Active tasks: taskId → { stream, abortController }
const tasks = new Map<
  string,
  { stream: TaskStream; abort: AbortController }
>();

app.register(fastifyWebSocket);

// Serve static client files
app.get("/", async (req, reply) => {
  const html = fs.readFileSync(
    path.join(__dirname, "../client/terminal.html"),
    "utf-8"
  );
  reply.type("text/html").send(html);
});

app.get("/nerv.css", async (req, reply) => {
  const css = fs.readFileSync(
    path.join(__dirname, "../client/nerv.css"),
    "utf-8"
  );
  reply.type("text/css").send(css);
});

app.get("/terminal.js", async (req, reply) => {
  // In dev mode serve the raw TS comment pointing to terminal.ts
  // In prod this would be the compiled bundle
  reply.type("application/javascript").send(`// terminal.ts compiled bundle`);
});

/**
 * POST /run — start a task, return SSE stream
 *
 * Body: { prompt: string, files?: Record<string, string|{data:string,encoding:'base64'}>, network?: ... }
 * Binary files (xlsx etc.) are sent from the browser as { data: base64string, encoding: 'base64' }
 */
app.post("/run", async (req, reply) => {
  const body = req.body as {
    prompt?: string;
    files?: Record<string, string | { data: string; encoding: "base64" }>;
    network?: { allowedUrlPrefixes: string[] };
  };

  if (!body?.prompt) {
    return reply.code(400).send({ error: "prompt required" });
  }

  const taskId = randomUUID();
  const stream = new TaskStream();
  const abort = new AbortController();

  tasks.set(taskId, { stream, abort });

  // Hijack the raw response — Fastify must not touch it after this
  reply.hijack();

  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Task-Id": taskId,
  });

  const sendEvent = (event: TaskEvent) => {
    if (!reply.raw.writableEnded) {
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    }
  };

  stream.on("event", sendEvent);

  // Keep the handler alive until the task finishes
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

    // Detect client disconnect via the underlying TCP socket, not ServerResponse.
    // ServerResponse emits "close" too eagerly in Fastify v5 (before the client
    // actually disconnects), so we watch the socket directly.
    const socket = req.raw.socket;
    if (socket) {
      socket.once("close", () => {
        abort.abort("client disconnected");
        done();
      });
    }

    // Decode files: browser sends binary as { data: base64, encoding: 'base64' }
    const decodedFiles: Record<string, string | Buffer> = {};
    for (const [name, content] of Object.entries(body.files ?? {})) {
      if (typeof content === "object" && content.encoding === "base64") {
        decodedFiles[name] = Buffer.from(content.data, "base64");
      } else {
        decodedFiles[name] = content as string;
      }
    }

    runTask({
      prompt: body.prompt!,
      files: decodedFiles,
      network: body.network,
      stream,
      signal: abort.signal,
    }).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[MAGI] runTask error:", err);
      stream.abort(msg);
    });
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
 * POST /ws/side-channel/:taskId — inject side channel via HTTP (fallback)
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
  console.log(`\x1b[32m[MAGI] WebSocket /ws/:taskId for xterm.js\x1b[0m`);
});

export default app;
