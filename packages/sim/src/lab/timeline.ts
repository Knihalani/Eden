/**
 * A run's timeline: every engine span (`@eden/engine` `spans.ts`), each task's start and end, the engine's decisions,
 * and the process's CPU% and RSS sampled every second, written as JSONL for `timeline-report.ts`.
 *
 *   const timeline = new Timeline("out.jsonl", { tool: "hidden-funnel", config });
 *   new ContextPartner({ ..., onSpan: timeline.sink("seed41"), onTrace: timeline.traceSink("seed41") });
 *   const task = timeline.task("seed41", sessionId, taskId); ...; task.end({ delivered: true });
 *   await timeline.close();
 *
 * A lane is one engine instance (one `ContextPartner`): span ids are unique within it, so every record carries its
 * lane, and the report keys spans by (lane, id). Records hold what spans hold, nothing more: phase names, times,
 * counts, connector ids and session ids (no request, item text or item id, D19).
 *
 * Lines:
 * - `{"t":"meta", ...}` once, first: what was run, when, the clock origin;
 * - `{"t":"span", "lane", id, parent, name, startMs, endMs, cpuUs, attrs}`;
 * - `{"t":"task", "lane", "session", "id", startMs, endMs, attrs}`;
 * - `{"t":"trace", "lane", "session", decision, latencyMs, sourceCalls, modelCalls, costUsd, at}`;
 * - `{"t":"sample", at, cpuPct, rssMb, heapMb, spans}` every `sampleMs`;
 * - `{"t":"end", at, cpuUs, threadCpuUs, wallMs, spans}` once, last: the run's process CPU, its main thread's (what
 *   spans measure, `cpuNow`), and wall time.
 */
import { appendFileSync, writeFileSync } from "node:fs";
import { cpuNow, type Span, type SpanSink, type Trace, type TraceSink } from "@eden/engine";

const ORIGIN = performance.timeOrigin;
/** Lines held before they are appended to the file: a flush is one write of ~1 MB. */
const FLUSH_LINES = 5_000;

const cpuUs = () => {
  const c = process.cpuUsage();
  return c.user + c.system;
};
const nowMs = () => ORIGIN + performance.now();

export interface TaskHandle {
  end(attrs?: Record<string, string | number | boolean>): void;
}

export class Timeline {
  private lines: string[] = [];
  private spans = 0;
  private spansAtSample = 0;
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly c0 = cpuUs();
  private readonly thread0 = cpuNow();
  private readonly t0 = nowMs();
  private lastCpu = this.c0;
  private lastAt = this.t0;
  private closed = false;

  constructor(
    readonly path: string,
    meta: Record<string, unknown> = {},
    readonly sampleMs = 1_000,
  ) {
    writeFileSync(path, "");
    this.push({ t: "meta", at: this.t0, sampleMs, pid: process.pid, ...meta });
    this.timer = setInterval(() => this.sample(), sampleMs);
    // The sampler never keeps a finished run alive.
    this.timer.unref?.();
  }

  /** The span sink for one engine instance (`lane`). */
  sink(lane: string): SpanSink {
    return (span: Span) => {
      this.spans++;
      this.push({ t: "span", lane, ...span });
    };
  }

  /** The trace sink for one engine instance: decisions, counts and cost, never reasons or item ids. */
  traceSink(lane: string, also?: TraceSink): TraceSink {
    return (x: Trace) => {
      this.push({
        t: "trace",
        lane,
        session: x.sessionId,
        turn: x.turn,
        event: x.event,
        decision: x.decision,
        latencyMs: x.latencyMs,
        sourceCalls: x.sourceCalls,
        modelCalls: x.modelCalls,
        costUsd: x.costUsd,
        items: x.itemIds.length,
        at: nowMs(),
      });
      also?.(x);
    };
  }

  /** A harness task (one funnel request, one agent task) on `lane`, played as `session`. */
  task(lane: string, session: string, id: string): TaskHandle {
    const startMs = nowMs();
    return {
      end: (attrs) => this.push({ t: "task", lane, session, id, startMs, endMs: nowMs(), ...(attrs ? { attrs } : {}) }),
    };
  }

  /** Writes what is held, stops the sampler and records the run's CPU and wall time. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.sample();
    clearInterval(this.timer);
    const at = nowMs();
    this.push({
      t: "end",
      at,
      cpuUs: cpuUs() - this.c0,
      threadCpuUs: cpuNow() - this.thread0,
      wallMs: at - this.t0,
      spans: this.spans,
    });
    this.flush();
    this.closed = true;
  }

  private sample(): void {
    const at = nowMs();
    const c = cpuUs();
    const m = process.memoryUsage();
    const wall = at - this.lastAt;
    this.push({
      t: "sample",
      at,
      cpuPct: wall > 0 ? Number((((c - this.lastCpu) / 1_000 / wall) * 100).toFixed(1)) : 0,
      rssMb: Number((m.rss / 1_048_576).toFixed(1)),
      heapMb: Number((m.heapUsed / 1_048_576).toFixed(1)),
      spans: this.spans - this.spansAtSample,
    });
    this.lastAt = at;
    this.lastCpu = c;
    this.spansAtSample = this.spans;
  }

  private push(record: Record<string, unknown>): void {
    if (this.closed) return;
    this.lines.push(JSON.stringify(record));
    if (this.lines.length >= FLUSH_LINES) this.flush();
  }

  private flush(): void {
    if (this.lines.length === 0) return;
    appendFileSync(this.path, `${this.lines.join("\n")}\n`);
    this.lines = [];
  }
}
