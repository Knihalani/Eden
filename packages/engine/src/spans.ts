/**
 * Engine-wide span tracing: where each event's time goes, phase by phase, in wall and CPU time.
 *
 * Off by default, and then free: the partner holds no tracer and every call site is one optional-chained call on
 * null. On with `config.spans` (the partner keeps per-phase totals, `ContextPartner.spanStats`) or an `onSpan` sink
 * (each finished span is handed to it, for a recorder such as the lab's timeline).
 *
 * A span is content-free (D19): a fixed phase name, ids, times and counts. Never a query, a cue, an item's text or
 * its id. `attrs` holds connector ids, statuses, counts, decisions and the session id the trace already carries.
 *
 * Times: `startMs`/`endMs` are epoch milliseconds (fractional, from the monotonic clock), so spans line up with
 * samples a recorder takes on its own clock. `cpuUs` is the CPU time (user + system) of the thread running the engine
 * between start and end, read with `process.threadCpuUsage` (~0.3 µs a read; the process's `cpuUsage` where a runtime
 * lacks it, which also counts the runtime's garbage-collector and compiler threads: twice the thread's in a measured
 * allocation loop). JavaScript runs one thing at a time, so for a synchronous span that is the span's own CPU; an
 * asynchronous one (`attrs.async`, a source call, a model call, a whole lookup) waits, and its figure includes whatever
 * else ran meanwhile, so one opened as asynchronous reads no CPU (`cpuUs` 0). Reports take CPU from synchronous spans.
 */
import { Histogram } from "@eden/primitives";

export type SpanAttrs = Record<string, string | number | boolean>;

/** One finished phase. `parent` is 0 for a root (an `observe` or an `ask`). */
export interface Span {
  id: number;
  parent: number;
  name: string;
  startMs: number;
  endMs: number;
  cpuUs: number;
  attrs?: SpanAttrs;
}

export type SpanSink = (span: Span) => void;

/**
 * A span still running: the span itself, its end and CPU not yet set (`cpuUs` holds the CPU reading at its start).
 * One object per span from open to sink: the tracer allocates nothing else on its path.
 */
export type OpenSpan = Span;

/**
 * The phase names the engine emits, for recorders and reports. A name is fixed text, never built from content; a
 * probe's span is `probe.` and its kind, a closed set (`ProbeKind`).
 */
export const SPAN_NAMES = [
  "observe",
  "observe.prep",
  "fast.rank",
  "fast.confident",
  "slow",
  "route",
  "search",
  "source.search",
  "source.fetch",
  "sanitize",
  "probes",
  "probes.grace",
  "probe.*",
  "orgs",
  "cache.put",
  "mentions",
  "refresh",
  "rank",
  "conflict",
  "confident",
  "ground",
  "fallback",
  "judge.tied",
  "judge.build",
  "model",
  "judge.parse",
  "deliver",
  "fold",
  "render",
  "shadow",
  "ask",
  "sync.freshen",
  "sync.list",
  "graph.walk",
] as const;

const ORIGIN = performance.timeOrigin;

type CpuRead = () => { user: number; system: number };
/** This thread's CPU reader, or the process's (`process.threadCpuUsage` is Node 23.9+ and Bun). */
const readCpu: CpuRead =
  typeof (process as { threadCpuUsage?: CpuRead }).threadCpuUsage === "function"
    ? (process as unknown as { threadCpuUsage: CpuRead }).threadCpuUsage.bind(process)
    : () => process.cpuUsage();

/** CPU so far of the thread running the engine (or the process), in µs. */
export function cpuNow(): number {
  const c = readCpu();
  return c.user + c.system;
}

export class Tracer {
  private next = 1;
  /** Raw source pages by the span of the call that returned them, so the gate's span can name its parent. */
  private readonly pages = new WeakMap<object, number>();

  constructor(private readonly sink: SpanSink) {}

  open(name: string, parent = 0, attrs?: SpanAttrs): OpenSpan {
    // An asynchronous span's CPU is not its own (it waits while others run): not read. A CPU read is a system call
    // (~0.3 µs alone, several µs under load), the tracer's main cost.
    const waits = attrs?.async === true;
    const span: Span = {
      id: this.next++,
      parent,
      name,
      startMs: ORIGIN + performance.now(),
      endMs: 0,
      cpuUs: waits ? -1 : cpuNow(),
    };
    if (attrs) span.attrs = attrs;
    return span;
  }

  /** Ends `o`, merging `attrs` into what it was opened with, and hands it to the sink. */
  close(o: OpenSpan, attrs?: SpanAttrs): void {
    o.endMs = ORIGIN + performance.now();
    // -1: opened as asynchronous; a span found asynchronous only at its end keeps its (inclusive) reading.
    o.cpuUs = o.cpuUs < 0 ? 0 : cpuNow() - o.cpuUs;
    if (attrs) o.attrs = o.attrs ? Object.assign(o.attrs, attrs) : attrs;
    try {
      this.sink(o);
    } catch {
      // A broken sink never breaks a lookup.
    }
  }

  /** Remembers that `page` (a source's raw answer) came back under span `id`. */
  page(page: object, id: number): void {
    this.pages.set(page, id);
  }

  /** The span of the source call that returned `page`, or 0. */
  pageOf(page: readonly object[]): number {
    return this.pages.get(page) ?? (page.length === 1 ? this.pages.get(page[0]!) : undefined) ?? 0;
  }
}

/** Per-phase totals for `config.spans` with no sink: counts, wall and CPU time, and a latency histogram. */
export interface SpanStat {
  name: string;
  count: number;
  wallMs: number;
  /** CPU of synchronous spans only (an asynchronous span's CPU includes what ran meanwhile). */
  cpuMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
}

/** Phase names held at most (the engine's are fixed; this bounds what a caller's names could grow). */
const MAX_NAMES = 128;

interface Acc {
  count: number;
  wallMs: number;
  cpuUs: number;
  maxMs: number;
  hist: Histogram;
}

/** Aggregates spans in constant memory per phase name. */
export class SpanStats {
  private readonly acc = new Map<string, Acc>();

  record(span: Span): void {
    let a = this.acc.get(span.name);
    if (!a) {
      if (this.acc.size >= MAX_NAMES) return;
      a = { count: 0, wallMs: 0, cpuUs: 0, maxMs: 0, hist: new Histogram() };
      this.acc.set(span.name, a);
    }
    const ms = Math.max(0, span.endMs - span.startMs);
    a.count++;
    a.wallMs += ms;
    if (span.attrs?.async !== true) a.cpuUs += span.cpuUs;
    if (ms > a.maxMs) a.maxMs = ms;
    a.hist.record(ms);
  }

  snapshot(): SpanStat[] {
    return [...this.acc].map(([name, a]) => ({
      name,
      count: a.count,
      wallMs: a.wallMs,
      cpuMs: a.cpuUs / 1_000,
      p50Ms: a.hist.quantile(0.5),
      p95Ms: a.hist.quantile(0.95),
      p99Ms: a.hist.quantile(0.99),
      maxMs: a.maxMs,
    }));
  }

  reset(): void {
    this.acc.clear();
  }
}
