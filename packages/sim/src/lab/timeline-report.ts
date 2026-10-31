#!/usr/bin/env bun
/**
 * Where a run's time went, from a timeline (`timeline.ts`, `--timeline out.jsonl` on hidden-funnel or quality-cli):
 *
 * - per phase: count, wall p50/p95/p99, total wall, and self CPU (synchronous spans only: an asynchronous span's CPU
 *   includes whatever ran meanwhile) as a share of the process's CPU over the run;
 * - the critical path of each delivery: from the lookup's start to its delivery, the chain of phases that each ended
 *   last, and how much of that path each phase holds;
 * - a per-second histogram of activity: spans and source calls started, traced CPU, and the sampled CPU% and RSS;
 * - the slowest 20 tasks with their span trees.
 *
 *   bun packages/sim/src/lab/timeline-report.ts out.jsonl [--json report.json] [--top 20] [--quiet]
 */
import { readFileSync, writeFileSync } from "node:fs";

export interface SpanRec {
  lane: string;
  id: number;
  parent: number;
  name: string;
  startMs: number;
  endMs: number;
  cpuUs: number;
  attrs?: Record<string, string | number | boolean>;
}
interface TaskRec {
  lane: string;
  session: string;
  id: string;
  startMs: number;
  endMs: number;
  attrs?: Record<string, unknown>;
}
interface Sample {
  at: number;
  cpuPct: number;
  rssMb: number;
  heapMb: number;
}

export interface Timeline {
  meta: Record<string, unknown>;
  spans: SpanRec[];
  tasks: TaskRec[];
  samples: Sample[];
  end: { at: number; cpuUs: number; threadCpuUs?: number; wallMs: number } | null;
}

export function load(path: string): Timeline {
  const t: Timeline = { meta: {}, spans: [], tasks: [], samples: [], end: null };
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line) continue;
    const r = JSON.parse(line) as Record<string, unknown> & { t: string };
    if (r.t === "span") t.spans.push(r as unknown as SpanRec);
    else if (r.t === "task") t.tasks.push(r as unknown as TaskRec);
    else if (r.t === "sample") t.samples.push(r as unknown as Sample);
    else if (r.t === "meta") t.meta = r;
    else if (r.t === "end") t.end = r as unknown as Timeline["end"];
  }
  return t;
}

const key = (lane: string, id: number) => `${lane}#${id}`;
const isAsync = (s: SpanRec) => s.attrs?.async === true;
const wall = (s: SpanRec) => Math.max(0, s.endMs - s.startMs);

/** The q-quantile of sorted `xs` (nearest rank). */
function q(xs: number[], p: number): number {
  if (xs.length === 0) return 0;
  return xs[Math.min(xs.length - 1, Math.max(0, Math.ceil(p * xs.length) - 1))]!;
}

export interface Index {
  byKey: Map<string, SpanRec>;
  kids: Map<string, SpanRec[]>;
}

export function index(spans: SpanRec[]): Index {
  const byKey = new Map<string, SpanRec>();
  const kids = new Map<string, SpanRec[]>();
  for (const s of spans) byKey.set(key(s.lane, s.id), s);
  for (const s of spans) {
    if (s.parent === 0) continue;
    const k = key(s.lane, s.parent);
    let list = kids.get(k);
    if (!list) kids.set(k, (list = []));
    list.push(s);
  }
  return { byKey, kids };
}

/**
 * A span's own CPU: its CPU less its synchronous children's. An asynchronous span's CPU is not its own (null), except
 * a source call's synchronous part (`syncCpuUs`: all of an in-process connector's search).
 */
function selfCpuUs(s: SpanRec, ix: Index): number | null {
  if (isAsync(s)) return typeof s.attrs?.syncCpuUs === "number" ? s.attrs.syncCpuUs : null;
  let kids = 0;
  for (const k of ix.kids.get(key(s.lane, s.id)) ?? []) if (!isAsync(k)) kids += k.cpuUs;
  return Math.max(0, s.cpuUs - kids);
}

export interface PhaseRow {
  name: string;
  n: number;
  async: boolean;
  p50: number;
  p95: number;
  p99: number;
  totalWallMs: number;
  selfCpuMs: number;
  cpuShare: number;
}

export function phases(t: Timeline, ix: Index): { rows: PhaseRow[]; tracedCpuMs: number; processCpuMs: number } {
  const by = new Map<string, { walls: number[]; cpu: number; async: boolean }>();
  let traced = 0;
  for (const s of t.spans) {
    let a = by.get(s.name);
    if (!a) by.set(s.name, (a = { walls: [], cpu: 0, async: false }));
    a.walls.push(wall(s));
    const self = selfCpuUs(s, ix);
    if (isAsync(s)) a.async = true;
    if (self !== null) {
      a.cpu += self;
      traced += self;
    }
  }
  // Spans measure the engine thread's CPU: their share is of that thread's (the process's on older runs).
  const processCpuMs = (t.end?.threadCpuUs ?? t.end?.cpuUs ?? traced) / 1_000;
  const rows = [...by].map(([name, a]) => {
    a.walls.sort((x, y) => x - y);
    return {
      name,
      n: a.walls.length,
      async: a.async,
      p50: q(a.walls, 0.5),
      p95: q(a.walls, 0.95),
      p99: q(a.walls, 0.99),
      totalWallMs: a.walls.reduce((x, y) => x + y, 0),
      selfCpuMs: a.cpu / 1_000,
      cpuShare: processCpuMs > 0 ? a.cpu / 1_000 / processCpuMs : 0,
    };
  });
  rows.sort((x, y) => y.selfCpuMs - x.selfCpuMs || y.totalWallMs - x.totalWallMs);
  return { rows, tracedCpuMs: traced / 1_000, processCpuMs };
}

/**
 * The critical path from `node`'s start to `end`: walking back from the end, the child that ended last before the
 * cursor, then its own critical path, then what came before it. Time no child covers is the node's own.
 * Children that end after `end` (probes still running when the lookup delivered) are not on the path.
 */
export function criticalPath(node: SpanRec, end: number, ix: Index, out: [string, number][] = []): [string, number][] {
  const kids = (ix.kids.get(key(node.lane, node.id)) ?? []).filter((k) => k.endMs > node.startMs);
  let cursor = end;
  for (;;) {
    let best: SpanRec | null = null;
    for (const k of kids) {
      if (k.endMs <= cursor + 1e-6 && k.startMs < cursor && (!best || k.endMs > best.endMs)) best = k;
    }
    if (!best) break;
    if (cursor - best.endMs > 0) out.push([`${node.name} (self)`, cursor - best.endMs]);
    criticalPath(best, best.endMs, ix, out);
    cursor = Math.max(node.startMs, best.startMs);
  }
  if (cursor - node.startMs > 0) out.push([`${node.name} (self)`, cursor - node.startMs]);
  return out;
}

export interface CriticalRow {
  name: string;
  totalMs: number;
  share: number;
  onPaths: number;
}

/** Deliveries: a slow path that delivered, or an event delivered from the cache (no slow path under it). */
export function deliveries(t: Timeline, ix: Index): SpanRec[] {
  const out: SpanRec[] = [];
  for (const s of t.spans) {
    if (s.name === "slow" && s.attrs?.delivered === true) out.push(s);
    else if (s.parent === 0 && s.attrs?.delivered === true && s.attrs?.decision === "fast") out.push(s);
    else if (s.name === "ask" && s.attrs?.delivered === true) out.push(s);
  }
  void ix;
  return out;
}

export function critical(t: Timeline, ix: Index): { rows: CriticalRow[]; n: number; p50: number; p95: number } {
  const per = new Map<string, { ms: number; paths: number }>();
  const lengths: number[] = [];
  let total = 0;
  const anchors = deliveries(t, ix);
  for (const d of anchors) {
    const path = criticalPath(d, d.endMs, ix);
    const seen = new Set<string>();
    for (const [name, ms] of path) {
      const a = per.get(name) ?? { ms: 0, paths: 0 };
      a.ms += ms;
      if (!seen.has(name)) a.paths++;
      seen.add(name);
      per.set(name, a);
      total += ms;
    }
    lengths.push(wall(d));
  }
  lengths.sort((x, y) => x - y);
  const rows = [...per]
    .map(([name, a]) => ({ name, totalMs: a.ms, share: total > 0 ? a.ms / total : 0, onPaths: a.paths }))
    .sort((x, y) => y.totalMs - x.totalMs);
  return { rows, n: anchors.length, p50: q(lengths, 0.5), p95: q(lengths, 0.95) };
}

export interface SecondRow {
  s: number;
  spans: number;
  sourceCalls: number;
  modelCalls: number;
  tracedCpuMs: number;
  cpuPct: number | null;
  rssMb: number | null;
}

export function perSecond(t: Timeline, ix: Index): SecondRow[] {
  const t0 = Number(t.meta.at ?? Math.min(...t.spans.map((s) => s.startMs)));
  const rows = new Map<number, SecondRow>();
  const row = (s: number) => {
    let r = rows.get(s);
    if (!r)
      rows.set(s, (r = { s, spans: 0, sourceCalls: 0, modelCalls: 0, tracedCpuMs: 0, cpuPct: null, rssMb: null }));
    return r;
  };
  for (const s of t.spans) {
    const r = row(Math.max(0, Math.floor((s.startMs - t0) / 1_000)));
    r.spans++;
    if (s.name === "source.search" || s.name === "source.fetch") r.sourceCalls++;
    if (s.name === "model") r.modelCalls++;
    // Top-level synchronous spans only, so nested CPU is not counted twice.
    const parent = s.parent === 0 ? undefined : ix.byKey.get(key(s.lane, s.parent));
    if (!isAsync(s) && (!parent || isAsync(parent))) r.tracedCpuMs += s.cpuUs / 1_000;
    else if (typeof s.attrs?.syncCpuUs === "number") r.tracedCpuMs += s.attrs.syncCpuUs / 1_000;
  }
  // A sample covers the second before it.
  for (const x of t.samples) {
    const r = row(Math.max(0, Math.floor((x.at - t0) / 1_000) - 1));
    r.cpuPct = x.cpuPct;
    r.rssMb = x.rssMb;
  }
  return [...rows.values()].sort((a, b) => a.s - b.s);
}

export interface TaskTree {
  id: string;
  wallMs: number;
  attrs?: Record<string, unknown>;
  tree: string[];
}

/** One line per span (or per run of same-named siblings past three), indented by depth. */
function render(node: SpanRec, ix: Index, depth: number, out: string[], t0: number, maxDepth = 6): void {
  const cpu = isAsync(node) ? "" : ` cpu ${(node.cpuUs / 1_000).toFixed(2)}`;
  const attrs = node.attrs
    ? ` ${Object.entries(node.attrs)
        .filter(([k]) => k !== "async" && k !== "session")
        .map(([k, v]) => `${k}=${v}`)
        .join(" ")}`
    : "";
  out.push(
    `${"  ".repeat(depth)}${node.name}${isAsync(node) ? "~" : ""} +${(node.startMs - t0).toFixed(1)} ` +
      `${wall(node).toFixed(2)} ms${cpu}${attrs}`.trimEnd(),
  );
  if (depth >= maxDepth) return;
  const kids = [...(ix.kids.get(key(node.lane, node.id)) ?? [])].sort((a, b) => a.startMs - b.startMs);
  const groups = new Map<string, SpanRec[]>();
  for (const k of kids) {
    const g = groups.get(k.name) ?? [];
    g.push(k);
    groups.set(k.name, g);
  }
  for (const [name, g] of groups) {
    if (g.length > 3) {
      const ms = g.map(wall);
      out.push(
        `${"  ".repeat(depth + 1)}${name} x${g.length}: sum ${ms.reduce((a, b) => a + b, 0).toFixed(2)} ms, ` +
          `max ${Math.max(...ms).toFixed(2)} ms`,
      );
    } else for (const k of g) render(k, ix, depth + 1, out, t0, maxDepth);
  }
}

export function slowest(t: Timeline, ix: Index, top: number): TaskTree[] {
  const roots = t.spans.filter((s) => s.parent === 0);
  // Without task records, each event (root span) is a task.
  const tasks: { id: string; start: number; end: number; roots: SpanRec[]; attrs?: Record<string, unknown> }[] =
    t.tasks.length > 0
      ? t.tasks.map((x) => ({
          id: x.id,
          start: x.startMs,
          end: x.endMs,
          attrs: x.attrs,
          roots: roots.filter(
            (r) =>
              r.lane === x.lane && r.attrs?.session === x.session && r.startMs >= x.startMs - 1 && r.startMs <= x.endMs,
          ),
        }))
      : roots.map((r) => ({
          id: `${r.lane}/${r.attrs?.session ?? ""}#${r.attrs?.turn ?? ""}`,
          start: r.startMs,
          end: r.endMs,
          roots: [r],
        }));
  tasks.sort((a, b) => b.end - b.start - (a.end - a.start));
  return tasks.slice(0, top).map((x) => {
    const tree: string[] = [];
    for (const r of x.roots) render(r, ix, 0, tree, x.start);
    return { id: x.id, wallMs: x.end - x.start, ...(x.attrs ? { attrs: x.attrs } : {}), tree };
  });
}

export function report(t: Timeline, top = 20) {
  const ix = index(t.spans);
  return {
    meta: t.meta,
    run: t.end,
    spans: t.spans.length,
    phases: phases(t, ix),
    critical: critical(t, ix),
    perSecond: perSecond(t, ix),
    slowest: slowest(t, ix, top),
  };
}

const bar = (x: number, max: number, width = 40) => "#".repeat(Math.round((Math.max(0, x) / (max || 1)) * width));

if (import.meta.main) {
  const args = process.argv.slice(2);
  const opt = (name: string, fallback: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && args[i + 1] ? args[i + 1]! : fallback;
  };
  const path = args.find((a) => !a.startsWith("--") && args[args.indexOf(a) - 1]?.startsWith("--") !== true);
  if (!path) throw new Error("usage: timeline-report.ts out.jsonl [--json report.json] [--top 20] [--quiet]");
  const r = report(load(path), Number(opt("top", "20")));
  const json = opt("json", "");
  if (json) writeFileSync(json, JSON.stringify(r, null, 2));
  const f = (x: number, d = 2) => x.toFixed(d);
  console.log(
    `timeline ${path}: ${r.spans} spans, run ${f((r.run?.wallMs ?? 0) / 1_000, 1)} s wall, ` +
      `${f((r.run?.cpuUs ?? 0) / 1e6, 1)} s CPU`,
  );
  const p = r.phases;
  console.log(
    `\nphases (wall ms; self CPU of synchronous spans; traced ${f(p.tracedCpuMs / 1_000, 2)} s of ` +
      `${f(p.processCpuMs / 1_000, 2)} s process CPU = ${f((100 * p.tracedCpuMs) / Math.max(1, p.processCpuMs), 1)}%)`,
  );
  console.log("phase                     n     p50      p95      p99   total s  self CPU s  CPU%");
  for (const x of p.rows) {
    console.log(
      `${(x.name + (x.async ? "~" : "")).padEnd(20)} ${String(x.n).padStart(7)} ${f(x.p50).padStart(7)} ` +
        `${f(x.p95).padStart(8)} ${f(x.p99).padStart(8)} ${f(x.totalWallMs / 1_000).padStart(9)} ` +
        `${(x.selfCpuMs > 0 || !x.async ? f(x.selfCpuMs / 1_000, 3) : "-").padStart(11)} ` +
        `${(x.selfCpuMs > 0 || !x.async ? f(100 * x.cpuShare, 1) : "-").padStart(5)}`,
    );
  }
  const c = r.critical;
  console.log(
    `\ncritical path over ${c.n} deliveries (lookup start to delivery: p50 ${f(c.p50)} ms, p95 ${f(c.p95)} ms)`,
  );
  for (const x of c.rows.slice(0, 15)) {
    console.log(
      `${x.name.padEnd(24)} ${f(x.totalMs).padStart(10)} ms ${f(100 * x.share, 1).padStart(5)}%  on ${x.onPaths}`,
    );
  }
  if (!args.includes("--quiet")) {
    console.log("\nper second: spans, source calls, model calls, traced CPU ms, sampled CPU%, RSS MB");
    const maxCpu = Math.max(...r.perSecond.map((x) => x.cpuPct ?? 0), 100);
    for (const x of r.perSecond) {
      console.log(
        `${String(x.s).padStart(4)}s ${String(x.spans).padStart(6)} ${String(x.sourceCalls).padStart(5)} ` +
          `${String(x.modelCalls).padStart(4)} ${f(x.tracedCpuMs, 0).padStart(6)} ` +
          `${(x.cpuPct === null ? "-" : f(x.cpuPct, 0)).padStart(5)} ${(x.rssMb === null ? "-" : f(x.rssMb, 0)).padStart(5)} ` +
          bar(x.cpuPct ?? 0, maxCpu),
      );
    }
    console.log(`\nslowest ${r.slowest.length} tasks (~ marks an asynchronous span: its CPU is not its own)`);
    for (const x of r.slowest) {
      console.log(`\n${x.id}  ${f(x.wallMs)} ms ${x.attrs ? JSON.stringify(x.attrs) : ""}`);
      for (const l of x.tree) console.log(`  ${l}`);
    }
  }
}
