import { EventEmitter } from "events";

export type TaskEvent =
  | { type: "thinking" }
  | { type: "token"; content: string }
  | { type: "command"; command: string }
  | { type: "side_channel"; message: string }
  | { type: "done"; output: Record<string, string> }
  | { type: "error"; error: string };

/**
 * TaskStream — fan-out event bus for a single running task.
 *
 * Producers (runner.ts) call write/command/complete/abort.
 * Consumers (server.ts SSE, WebSocket) subscribe via on("event", ...).
 */
export class TaskStream extends EventEmitter {
  private _aborted = false;
  private _pendingSideChannel: string[] = [];

  /** Signal that the LLM is processing — client shows spinner */
  thinking(): void {
    if (this._aborted) return;
    this.emit("event", { type: "thinking" } satisfies TaskEvent);
  }

  /** Emit raw terminal bytes — streams to xterm.js and SSE */
  write(text: string): void {
    if (this._aborted) return;
    this.emit("event", { type: "token", content: text } satisfies TaskEvent);
  }

  /** Emit a command observation (for logging/status bar) */
  command(cmd: string): void {
    if (this._aborted) return;
    this.emit("event", { type: "command", command: cmd } satisfies TaskEvent);
  }

  /** Queue a side-channel operator note for injection */
  sideChannel(msg: string): void {
    this._pendingSideChannel.push(msg);
    this.emit("event", {
      type: "side_channel",
      message: msg,
    } satisfies TaskEvent);
  }

  /** Drain all pending side-channel messages and return formatted injection */
  drainSideChannel(): string {
    if (this._pendingSideChannel.length === 0) return "";
    const now = new Date().toTimeString().slice(0, 8);
    const notes = this._pendingSideChannel
      .map((msg) => `[OPERATOR NOTE — ${now}]\n${msg}\n[END OPERATOR NOTE]`)
      .join("\n\n");
    this._pendingSideChannel = [];
    return notes;
  }

  hasPendingSideChannel(): boolean {
    return this._pendingSideChannel.length > 0;
  }

  /** Task completed successfully */
  complete(output: Record<string, string>): void {
    if (this._aborted) return;
    this.emit("event", { type: "done", output } satisfies TaskEvent);
    this.emit("complete");
  }

  /** Task aborted or errored */
  abort(reason?: string): void {
    this._aborted = true;
    this.emit("event", {
      type: "error",
      error: reason ?? "ABORT",
    } satisfies TaskEvent);
    this.emit("abort");
  }

  get aborted(): boolean {
    return this._aborted;
  }
}
