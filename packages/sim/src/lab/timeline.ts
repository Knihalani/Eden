/**
 * Per-task timelines for the live agent benchmark (`pi-ab.ts`, `pi-ab-report.ts`): what happened when, on one
 * monotonic clock, and the arithmetic that turns spans into a critical path and a per-second profile.
 *
 * A span's `lane` says whether the agent was waiting on it. "path" spans are the agent loop's own steps (Eden's
 * blocking observe, each model request, each tool call); they do not overlap except for tools run in parallel.
 * "bg" spans are work beside the loop (Eden's slow path still running, its probes and judge, grading after the end):
 * they overlap the path and are reported apart from it.
 */

/** Where the time of a span goes in the breakdown. `other` is path time no span covers (the loop's own work). */
export type Category = "model" | "tool" | "eden" | "grading" | "other";
export const CATEGORIES: Category[] = ["eden", "model", "tool", "grading", "other"];

export interface TimelineEvent {
  /** Milliseconds since the task started, on `performance.now()`. */
  t: number;
  /** "B" begins span `id`, "E" ends it, "I" is an instant. */
  ph: "B" | "E" | "I";
  ev: string;
  id?: number;
  cat?: Category;
  lane?: "path" | "bg";
  data?: Record<string, unknown>;
}

export interface Span {
  ev: string;
  cat: Category;
  lane: "path" | "bg";
  start: number;
  end: number;
  data?: Record<string, unknown>;
}

/** One task's timeline: spans and instants against the task's own start. Bounded by `maxEvents` (then dropped). */
export class Timeline {
  readonly events: TimelineEvent[] = [];
  private next = 1;
  private readonly open = new Map<number, { ev: string; cat: Category; lane: "path" | "bg" }>();
  dropped = 0;

  constructor(
    readonly origin = performance.now(),
    private readonly maxEvents = 5_000,
  ) {}

  /** Milliseconds since the task started for a `performance.now()` reading. */
  at(now = performance.now()): number {
    return Math.round((now - this.origin) * 100) / 100;
  }

  private push(e: TimelineEvent): void {
    if (this.events.length >= this.maxEvents) this.dropped++;
    else this.events.push(e);
  }

  begin(ev: string, cat: Category, lane: "path" | "bg", data?: Record<string, unknown>, now?: number): number {
    const id = this.next++;
    this.open.set(id, { ev, cat, lane });
    this.push({ t: this.at(now), ph: "B", ev, id, cat, lane, ...(data ? { data } : {}) });
    return id;
  }

  end(id: number, data?: Record<string, unknown>, now?: number): void {
    const o = this.open.get(id);
    if (!o) return;
    this.open.delete(id);
    this.push({ t: this.at(now), ph: "E", ev: o.ev, id, cat: o.cat, lane: o.lane, ...(data ? { data } : {}) });
  }

  /** A span already over, from two `performance.now()` readings (an engine span, a source call). */
  span(ev: string, cat: Category, lane: "path" | "bg", start: number, end: number, data?: Record<string, unknown>) {
    const id = this.begin(ev, cat, lane, data, start);
    this.end(id, undefined, end);
  }

  point(ev: string, data?: Record<string, unknown>, now?: number): void {
    this.push({ t: this.at(now), ph: "I", ev, ...(data ? { data } : {}) });
  }
}

/** The spans of a timeline's events: each "B" paired with its "E" (an unclosed span ends at the last event). */
export function spansOf(events: TimelineEvent[]): Span[] {
  const open = new Map<number, TimelineEvent>();
  const out: Span[] = [];
  const last = events.reduce((m, e) => Math.max(m, e.t), 0);
  for (const e of events) {
    if (e.ph === "B" && e.id !== undefined) open.set(e.id, e);
    else if (e.ph === "E" && e.id !== undefined) {
      const b = open.get(e.id);
      if (!b) continue;
      open.delete(e.id);
      out.push(spanOf(b, e.t, e.data));
    }
  }
  for (const b of open.values()) out.push(spanOf(b, last));
  return out.sort((a, b) => a.start - b.start);
}

const spanOf = (b: TimelineEvent, end: number, more?: Record<string, unknown>): Span => ({
  ev: b.ev,
  cat: b.cat ?? "other",
  lane: b.lane ?? "path",
  start: b.t,
  end: Math.max(b.t, end),
  ...(b.data || more ? { data: { ...b.data, ...more } } : {}),
});

/** Higher wins where path spans overlap: Eden's wait inside a tool call (ask_context) is Eden's, not the tool's. */
const PRIORITY: Record<Category, number> = { eden: 4, tool: 3, model: 2, grading: 1, other: 0 };

/**
 * Milliseconds of `[from, to)` per category, each instant given to the highest-priority path span covering it, and
 * `other` where none does. O(n²) in the window's path spans, which number tens per task.
 */
export function breakdown(spans: Span[], from: number, to: number): Record<Category, number> {
  const out: Record<Category, number> = { eden: 0, model: 0, tool: 0, grading: 0, other: 0 };
  if (to <= from) return out;
  const path = spans.filter((s) => s.lane === "path" && s.end > from && s.start < to);
  const cuts = [...new Set([from, to, ...path.flatMap((s) => [s.start, s.end])])]
    .filter((x) => x >= from && x <= to)
    .sort((a, b) => a - b);
  for (let i = 0; i + 1 < cuts.length; i++) {
    const a = cuts[i]!;
    const b = cuts[i + 1]!;
    let best: Category = "other";
    for (const s of path) if (s.start <= a && s.end >= b && PRIORITY[s.cat] > PRIORITY[best]) best = s.cat;
    out[best] += b - a;
  }
  return out;
}

/** The critical path in one-second buckets of task time: `breakdown` of each second up to `wallMs`. */
export function perSecond(spans: Span[], wallMs: number): Record<Category, number>[] {
  const out: Record<Category, number>[] = [];
  for (let s = 0; s * 1_000 < wallMs; s++) out.push(breakdown(spans, s * 1_000, Math.min(wallMs, (s + 1) * 1_000)));
  return out;
}

/** Milliseconds of `[from, to)` covered by any span of `lane` (by default the background: Eden beside the loop). */
export function covered(spans: Span[], from: number, to: number, lane: "path" | "bg" = "bg"): number {
  const xs = spans
    .filter((s) => s.lane === lane && s.end > from && s.start < to)
    .map((s) => [Math.max(from, s.start), Math.min(to, s.end)] as const)
    .sort((a, b) => a[0] - b[0]);
  // A merge of the sorted intervals: an empty list covers nothing (no infinite sentinels to subtract).
  let total = 0;
  let cur: [number, number] | null = null;
  for (const [a, b] of xs) {
    if (cur && a <= cur[1]) cur[1] = Math.max(cur[1], b);
    else {
      if (cur) total += cur[1] - cur[0];
      cur = [a, b];
    }
  }
  return cur ? total + cur[1] - cur[0] : total;
}

/** The `p` quantile by nearest rank (0 for none). */
export function quantile(xs: number[], p: number): number {
  if (!xs.length) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))]!;
}

/** A paired difference's mean and bootstrap 95% interval over its pairs, with `next` a uniform [0, 1) source. */
export function bootstrap(xs: number[], next: () => number, rounds = 2_000): { mean: number; lo: number; hi: number } {
  const mean = (v: number[]) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0);
  if (!xs.length) return { mean: 0, lo: 0, hi: 0 };
  const boots = Array.from({ length: rounds }, () => mean(xs.map(() => xs[Math.floor(next() * xs.length)]!))).sort(
    (a, b) => a - b,
  );
  return { mean: mean(xs), lo: boots[Math.floor(rounds * 0.025)]!, hi: boots[Math.floor(rounds * 0.975) - 1]! };
}
