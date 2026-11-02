/**
 * One Hermes worker of `hermes-ab.ts`: a process (packages/sim/lab/hermes/worker.py on Hermes' venv) running one task
 * at a time over JSON lines. On its own so a stub process can test its failure handling.
 *
 * - `started()` resolves with the worker's ready line (its MCP tools) or, if it dies first, with its death.
 * - `run()` sends one task. `ran: false` means the task was never sent (the worker was already dead): the caller must
 *   not count it as a task, only respawn. `ran: true` with an error is a task that ran and failed (it died mid-task, or
 *   timed out, which kills it: its late reply would otherwise be read as the next task's).
 * - A broken stdin (the process gone) is recorded, never thrown into the run.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

export interface Ready {
  ok: boolean;
  /** The MCP tools Hermes registered at start (`mcp__<server>__<tool>`). */
  mcpTools: string[];
  error?: string;
}

export interface Reply {
  ran: boolean;
  msg: Record<string, unknown>;
}

export class Worker {
  private proc: ChildProcessWithoutNullStreams;
  private waiting: ((msg: Record<string, unknown>) => void)[] = [];
  private ready: Promise<Ready>;
  private dead: string | null = null;

  constructor(command: string[], env: Record<string, string>, log: string) {
    this.proc = spawn(command[0]!, command.slice(1), { env });
    this.proc.stderr.on("data", (d: Buffer) => appendFileSync(log, d));
    this.proc.stdin.on("error", (e) => {
      appendFileSync(log, `\n[hermes-ab] worker stdin: ${e.message}\n`);
    });
    const lines = createInterface({ input: this.proc.stdout });
    let onReady: (r: Ready) => void = () => {};
    this.ready = new Promise((r) => (onReady = r));
    lines.on("line", (line) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return;
      }
      if (msg.op === "ready") {
        const tools = Array.isArray(msg.mcpTools) ? msg.mcpTools.filter((t): t is string => typeof t === "string") : [];
        return onReady({ ok: true, mcpTools: tools });
      }
      this.waiting.shift()?.(msg);
    });
    const died = (why: string) => {
      if (this.dead) return;
      this.dead = `${why}; see ${log}`;
      onReady({ ok: false, mcpTools: [], error: this.dead });
      for (const w of this.waiting.splice(0)) w({ error: this.dead });
    };
    this.proc.on("exit", (code, signal) => died(`worker exited (${signal ?? code})`));
    this.proc.on("error", (e) => died(`worker failed to start (${e.message})`));
  }

  started(): Promise<Ready> {
    return this.ready;
  }

  async run(req: Record<string, unknown>, timeoutMs: number): Promise<Reply> {
    const ready = await this.ready;
    if (!ready.ok || this.dead) return { ran: false, msg: { error: this.dead ?? ready.error } };
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.proc.kill("SIGKILL");
        resolve({ ran: true, msg: { error: `task timed out after ${timeoutMs} ms` } });
      }, timeoutMs);
      this.waiting.push((msg) => {
        clearTimeout(timer);
        resolve({ ran: true, msg });
      });
      this.proc.stdin.write(`${JSON.stringify(req)}\n`);
    });
  }

  get alive(): boolean {
    return this.dead === null;
  }

  close(): void {
    if (!this.dead) this.proc.stdin.end();
    setTimeout(() => this.proc.kill("SIGKILL"), 5_000).unref();
  }
}
