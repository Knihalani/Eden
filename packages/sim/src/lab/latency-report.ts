#!/usr/bin/env bun
/**
 * Eden's time on the agent's path, piece by piece (A18), from a `--timeline` file (hidden-funnel's, `timeline.ts`).
 *
 * Three kinds of root span are what an agent waits on: the request's `observe` (a user message: it waits for the
 * push up to `waitMs`), the push itself (an `ask` root the engine opens for the request, decision "reader-push") and
 * an explicit `ask` (decision "answer"). For each kind: count and wall p50/p90/p99/max; for each piece under it (its
 * descendants by name: the on-demand poll `sync.freshen`, the live `search`, the re-reads `verify`, `rank`, `render`,
 * ...), how often it ran, its wall p50/p90/p99 when it ran (from its first start to its last end inside the root),
 * and its mean share of the kind's wall (pieces may overlap: shares can sum past 100%).
 *
 *   bun packages/sim/src/lab/latency-report.ts out.jsonl [--json out.json]
 */
import { readFileSync, writeFileSync } from "node:fs";

interface SpanRec {
  lane: string;
  id: number;
  parent: number;
  name: string;
  startMs: number;
  endMs: number;
  attrs?: Record<string, string | number | boolean>;
}

export interface PieceStats {
  n: number;
  /** Share of the kind's roots it ran in. */
  ran: number;
  p50: number;
  p90: number;
  p99: number;
  max: number;
  /** Its time over the kind's whole wall time (mean share). */
  share: number;
}
export interface KindStats {
  n: number;
  p50: number;
  p90: number;
  p99: number;
  max: number;
  mean: number;
  pieces: Record<string, PieceStats>;
}

export function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[i]!;
}

/** The kind of a root span, or "" for one no agent waits on (a session's start or end, a tool result, a draft). */
export function rootKind(sp: SpanRec): string {
  if (sp.name === "observe")
    return sp.attrs?.kind === "user_message" && sp.attrs?.decision !== "draft" ? "observe" : "";
  if (sp.name === "ask")
    return sp.attrs?.decision === "reader-push" ? "push" : sp.attrs?.decision === "answer" ? "ask" : "";
  return "";
}

export function breakdown(spans: readonly SpanRec[]): Record<string, KindStats> {
  const byKey = new Map<string, SpanRec>();
  for (const sp of spans) byKey.set(`${sp.lane}|${sp.id}`, sp);
  // Each span's root, through its parents (a parent that never closed, or another lane's, ends the walk).
  const rootOf = new Map<string, SpanRec>();
  const find = (sp: SpanRec): SpanRec => {
    const key = `${sp.lane}|${sp.id}`;
    const known = rootOf.get(key);
    if (known) return known;
    const parent = sp.parent ? byKey.get(`${sp.lane}|${sp.parent}`) : undefined;
    const root = parent ? find(parent) : sp;
    rootOf.set(key, root);
    return root;
  };
  // Per root: each piece's first start and last end.
  const pieces = new Map<SpanRec, Map<string, [number, number]>>();
  for (const sp of spans) {
    const root = find(sp);
    if (root === sp || !rootKind(root)) continue;
    const m = pieces.get(root) ?? new Map<string, [number, number]>();
    pieces.set(root, m);
    const at = m.get(sp.name);
    if (at) {
      at[0] = Math.min(at[0], sp.startMs);
      at[1] = Math.max(at[1], sp.endMs);
    } else m.set(sp.name, [sp.startMs, sp.endMs]);
  }
  const out: Record<string, KindStats> = {};
  const kinds = new Map<string, SpanRec[]>();
  for (const sp of spans) {
    const k = sp.parent === 0 ? rootKind(sp) : "";
    if (!k) continue;
    const list = kinds.get(k) ?? [];
    kinds.set(k, list);
    list.push(sp);
  }
  for (const [k, roots] of kinds) {
    const walls = roots.map((r) => r.endMs - r.startMs).sort((a, b) => a - b);
    const total = walls.reduce((a, b) => a + b, 0);
    const names = new Set<string>();
    for (const r of roots) for (const n of pieces.get(r)?.keys() ?? []) names.add(n);
    const per: Record<string, PieceStats> = {};
    for (const name of [...names].sort()) {
      const times = roots
        .map((r) => pieces.get(r)?.get(name))
        .filter((x): x is [number, number] => !!x)
        .map(([a, b]) => b - a)
        .sort((a, b) => a - b);
      const sum = times.reduce((a, b) => a + b, 0);
      per[name] = {
        n: times.length,
        ran: times.length / roots.length,
        p50: quantile(times, 0.5),
        p90: quantile(times, 0.9),
        p99: quantile(times, 0.99),
        max: times.at(-1) ?? 0,
        share: total > 0 ? sum / total : 0,
      };
    }
    out[k] = {
      n: roots.length,
      p50: quantile(walls, 0.5),
      p90: quantile(walls, 0.9),
      p99: quantile(walls, 0.99),
      max: walls.at(-1) ?? 0,
      mean: total / Math.max(1, roots.length),
      pieces: per,
    };
  }
  return out;
}

function fmt(ms: number): string {
  return ms >= 100 ? ms.toFixed(0) : ms >= 10 ? ms.toFixed(1) : ms.toFixed(2);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const file = args[0];
  if (!file) {
    console.error("usage: latency-report.ts timeline.jsonl [--json out.json]");
    process.exit(2);
  }
  const jsonAt = args.indexOf("--json");
  const spans: SpanRec[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line) continue;
    const r = JSON.parse(line) as SpanRec & { t: string };
    if (r.t === "span") spans.push(r);
  }
  const out: Record<string, unknown> = breakdown(spans);
  // `--funnel F.json` (the same run's `--json`): what the agent waited on per task, as the funnel timed it: the
  // request's observe with its push (`ms`, the observe call) and the ask (`askMs`).
  const funnelAt = args.indexOf("--funnel");
  if (funnelAt >= 0 && args[funnelAt + 1]) {
    const rows = (
      JSON.parse(readFileSync(args[funnelAt + 1]!, "utf8")) as { perTask: { ms: number; askMs?: number }[] }
    ).perTask;
    for (const [name, xs] of [
      ["request", rows.map((r) => r.ms)],
      ["askCall", rows.flatMap((r) => (r.askMs === undefined ? [] : [r.askMs]))],
    ] as const) {
      const sorted = [...xs].sort((a, b) => a - b);
      const mean = sorted.reduce((a, b) => a + b, 0) / Math.max(1, sorted.length);
      out[name] = {
        n: sorted.length,
        p50: quantile(sorted, 0.5),
        p90: quantile(sorted, 0.9),
        p99: quantile(sorted, 0.99),
        max: sorted.at(-1) ?? 0,
        mean,
      };
      console.log(
        `${name.padEnd(8)} n ${sorted.length}  wall p50 ${fmt(quantile(sorted, 0.5))}  p90 ${fmt(quantile(sorted, 0.9))}  ` +
          `p99 ${fmt(quantile(sorted, 0.99))}  max ${fmt(sorted.at(-1) ?? 0)}  mean ${fmt(mean)} ms  (funnel rows)`,
      );
    }
  }
  for (const k of ["observe", "push", "ask"]) {
    const s = out[k] as KindStats | undefined;
    if (!s) continue;
    console.log(
      `${k.padEnd(8)} n ${s.n}  wall p50 ${fmt(s.p50)}  p90 ${fmt(s.p90)}  p99 ${fmt(s.p99)}  max ${fmt(s.max)}  ` +
        `mean ${fmt(s.mean)} ms`,
    );
    const rows = Object.entries(s.pieces).sort((a, b) => b[1].share - a[1].share);
    for (const [name, p] of rows.slice(0, 12))
      console.log(
        `  ${name.padEnd(16)} ran ${(p.ran * 100).toFixed(0).padStart(3)}%  p50 ${fmt(p.p50).padStart(6)}  ` +
          `p90 ${fmt(p.p90).padStart(6)}  p99 ${fmt(p.p99).padStart(6)}  share ${(p.share * 100).toFixed(1)}%`,
      );
  }
  if (jsonAt >= 0 && args[jsonAt + 1]) writeFileSync(args[jsonAt + 1]!, JSON.stringify(out, null, 2));
}
