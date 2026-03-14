/**
 * terminal.ts — xterm.js + WebSocket wiring (TypeScript source)
 *
 * This is the TypeScript source for the terminal client.
 * For production, bundle with esbuild or similar:
 *   npx esbuild client/terminal.ts --bundle --outfile=client/terminal.js
 *
 * In dev, the HTML uses inline script + CDN xterm.js directly.
 */

import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";

export interface TaskEvent {
  type: "token" | "command" | "side_channel" | "done" | "error";
  content?: string;
  command?: string;
  message?: string;
  output?: Record<string, string>;
  error?: string;
}

export class NervTerminal {
  private term: Terminal;
  private fitAddon: FitAddon;
  private ws: WebSocket | null = null;
  private taskId: string | null = null;
  private stepCount = 0;
  private synchroRate = 0;

  constructor(container: HTMLElement) {
    this.term = new Terminal({
      disableStdin: true,
      cursorBlink: true,
      theme: {
        background: "#000000",
        foreground: "#00ff88",
        cursor: "#00ff88",
        cursorAccent: "#000000",
        selectionBackground: "rgba(0,255,136,0.2)",
        black: "#000000",
        brightBlack: "#333333",
        red: "#ff2200",
        brightRed: "#ff4422",
        green: "#00ff88",
        brightGreen: "#00ff88",
        yellow: "#ffaa00",
        brightYellow: "#ffcc44",
        blue: "#0088ff",
        brightBlue: "#44aaff",
        magenta: "#cc44ff",
        brightMagenta: "#dd88ff",
        cyan: "#00ccff",
        brightCyan: "#44eeff",
        white: "#00cc66",
        brightWhite: "#00ff88",
      },
      fontFamily: "'Share Tech Mono', 'VT323', monospace",
      fontSize: 13,
      lineHeight: 1.35,
      letterSpacing: 0.5,
      scrollback: 5000,
    });

    this.fitAddon = new FitAddon();
    this.term.loadAddon(this.fitAddon);
    this.term.open(container);
    this.fitAddon.fit();

    window.addEventListener("resize", () => this.fitAddon.fit());
    this.writeBootMessage();
  }

  private writeBootMessage(): void {
    const t = this.term;
    t.writeln("\x1b[32m╔══════════════════════════════════════════════════════╗\x1b[0m");
    t.writeln("\x1b[32m║  NERV // MAGI AGENT TERMINAL SYSTEM — BUILD 001      ║\x1b[0m");
    t.writeln("\x1b[32m║  特務機関NERV // GEHIRN BIOLOGIC LAB                 ║\x1b[0m");
    t.writeln("\x1b[32m╠══════════════════════════════════════════════════════╣\x1b[0m");
    t.writeln("\x1b[32m║  CASPAR   : ARCHITECTURE  ████████████ ONLINE        ║\x1b[0m");
    t.writeln("\x1b[32m║  BALTHASAR: PHILOSOPHY    ████████████ ONLINE        ║\x1b[0m");
    t.writeln("\x1b[32m║  MELCHIOR : EXEC ENGINE   ████████████ ONLINE        ║\x1b[0m");
    t.writeln("\x1b[32m╚══════════════════════════════════════════════════════╝\x1b[0m");
    t.writeln("");
    t.writeln("\x1b[2mAwaiting task initialisation...\x1b[0m");
    t.writeln("");
  }

  /** Connect to WebSocket for a running task */
  connectWebSocket(taskId: string): void {
    this.taskId = taskId;
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    this.ws = new WebSocket(`${proto}//${location.host}/ws/${taskId}`);

    this.ws.onopen = () => {
      this.onConnectionChange(true);
    };

    this.ws.onmessage = (e: MessageEvent) => {
      try {
        const event: TaskEvent = JSON.parse(e.data);
        this.handleEvent(event);
      } catch {
        // ignore malformed messages
      }
    };

    this.ws.onclose = () => {
      this.onConnectionChange(false);
    };

    this.ws.onerror = () => {
      this.onConnectionChange(false);
    };
  }

  /** Handle a TaskEvent from SSE or WebSocket */
  handleEvent(event: TaskEvent): void {
    switch (event.type) {
      case "token":
        if (event.content) {
          this.term.write(event.content);
          this.stepCount++;
          this.onStepUpdate(this.stepCount);
          this.updateSynchro();
        }
        break;

      case "command":
        // Commands are rendered inline with amber ANSI codes by runner.ts
        break;

      case "side_channel":
        this.term.writeln("\x1b[36m[OPERATOR NOTE QUEUED]\x1b[0m");
        break;

      case "done":
        this.term.writeln("");
        this.term.writeln(
          "\x1b[32m╔══════════════════════════════════════════════════════╗\x1b[0m"
        );
        this.term.writeln(
          "\x1b[32m║  TASK COMPLETE — PATTERN GREEN                       ║\x1b[0m"
        );
        this.term.writeln(
          "\x1b[32m╚══════════════════════════════════════════════════════╝\x1b[0m"
        );
        if (event.output?.["result.md"]) {
          this.term.writeln("");
          this.term.writeln("\x1b[32m── /output/result.md ──\x1b[0m");
          this.term.writeln(event.output["result.md"]);
        }
        this.onConditionChange("GREEN");
        this.onSynchroUpdate(100.0);
        break;

      case "error":
        this.term.writeln("");
        this.term.writeln(
          `\x1b[31m[CONDITION RED — ${event.error ?? "ABORT"}]\x1b[0m`
        );
        this.onConditionChange("RED");
        break;
    }
  }

  /** Send operator note via WebSocket */
  sendSideChannel(message: string): void {
    if (!message.trim()) return;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "side_channel", message }));
    } else if (this.taskId) {
      // HTTP fallback
      fetch(`/side-channel/${this.taskId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
      }).catch(console.error);
    }
    this.term.writeln(`\x1b[36m[OPERATOR → AGENT] ${message}\x1b[0m`);
  }

  private updateSynchro(): void {
    this.synchroRate = Math.min(
      99.9,
      this.synchroRate + (Math.random() * 1.5 - 0.2)
    );
    this.onSynchroUpdate(this.synchroRate);
  }

  // ── Override these callbacks in integrations ──────────────────────

  onConnectionChange(_connected: boolean): void {}
  onConditionChange(_condition: "GREEN" | "AMBER" | "RED" | "STANDBY"): void {}
  onStepUpdate(_step: number): void {}
  onSynchroUpdate(_rate: number): void {}
}
