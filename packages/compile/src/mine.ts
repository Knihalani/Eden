import type { StretchTrace } from "@eden/ir";
import { CHECK_MIN_SUPPORT, isCheckName } from "@eden/ir";

export type Cluster = {
  sequence: string[];
  traces: StretchTrace[];
};

/**
 * The tool names of a trace, in order.
 *
 * Memoised per trace object. clusterTraces() tests every candidate n-gram
 * against every trace, and medianIndex() re-walks every trace per name, so the
 * uncached version rebuilt two arrays on each of those O(grams x traces) probes
 * — the single hottest thing in the compiler. Traces are immutable for the
 * duration of a compile, so caching on identity is safe, and a WeakMap means
 * the entries disappear with the traces.
 */
const nameCache = new WeakMap<object, string[]>();

function names(t: StretchTrace): string[] {
  const hit = nameCache.get(t);
  if (hit) return hit;
  const out: string[] = [];
  for (const e of t.events) if (e.ok && !e.skipped) out.push(e.name);
  nameCache.set(t, out);
  return out;
}

export function oneInsert(a: string[], b: string[]): boolean {
  if (Math.abs(a.length - b.length) !== 1) return false;
  const [shorter, longer] = a.length < b.length ? [a, b] : [b, a];
  let i = 0;
  let extra: string | undefined;
  for (const t of longer) {
    if (i < shorter.length && t === shorter[i]) i++;
    else if (extra === undefined) extra = t;
    else return false;
  }
  if (i !== shorter.length || extra === undefined) return false;
  if (isCheckName(extra)) return false;
  return true;
}

export function oneSubstitute(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  let diffs = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) continue;
    diffs++;
    if (isCheckName(a[i]!) || isCheckName(b[i]!)) return false;
  }
  return diffs === 1;
}

function nearSeq(a: string[], b: string[]): boolean {
  return oneInsert(a, b) || oneSubstitute(a, b);
}

function medianIndex(traces: StretchTrace[], name: string): number {
  const idxs = traces
    .map((t) => names(t).indexOf(name))
    .filter((i) => i >= 0)
    .sort((a, b) => a - b);
  if (!idxs.length) return 99;
  return idxs[Math.floor(idxs.length / 2)]!;
}

function keep(name: string, count: number, n: number, minFrac: number): boolean {
  if (count / n >= minFrac) return true;
  // Reliability pin: a check the agent usually ran after a mutation still
  // compiles in. This was `Math.min(minFrac, 0.8)`, which at the default
  // minFrac of 0.8 is just minFrac — the pin never lowered anything, and a
  // verify step the agent ran in 7 of 10 traces was mined away, leaving a
  // compiled tool that writes and never checks.
  if (isCheckName(name) && count / n >= Math.min(minFrac, CHECK_MIN_SUPPORT) - 1e-9) return true;
  return false;
}

export function isContiguous(sub: string[], full: string[]): boolean {
  if (!sub.length || sub.length > full.length) return false;
  outer: for (let i = 0; i <= full.length - sub.length; i++) {
    for (let j = 0; j < sub.length; j++) if (full[i + j] !== sub[j]) continue outer;
    return true;
  }
  return false;
}

export function isSubsequence(sub: string[], full: string[]): boolean {
  if (!sub.length || sub.length > full.length) return false;
  let i = 0;
  for (const t of full) if (i < sub.length && t === sub[i]) i++;
  return i === sub.length;
}

export function majoritySequence(traces: StretchTrace[], minFrac = 0.8): string[] {
  const freq = new Map<string, number>();
  for (const t of traces) for (const n of new Set(names(t))) freq.set(n, (freq.get(n) ?? 0) + 1);
  const kept = new Set(
    [...freq.entries()].filter(([name, c]) => keep(name, c, traces.length, minFrac)).map(([n]) => n),
  );
  const ranked = [...traces].sort((a, b) => names(b).length - names(a).length || a.id.localeCompare(b.id));
  const expanded = (ranked[0] ? names(ranked[0]) : []).filter((n) => kept.has(n));
  if (expanded.length >= 3) return expanded.slice(0, 12);
  const unique = [...kept];
  // Decorate, sort, undecorate. medianIndex maps over every trace, does an
  // indexOf and sorts a fresh array, and calling it from inside a comparator
  // ran all of that O(U log U) times.
  const medians = new Map(unique.map((n) => [n, medianIndex(traces, n)]));
  unique.sort((a, b) => medians.get(a)! - medians.get(b)! || a.localeCompare(b));
  return unique;
}

function namesBefore(t: StretchTrace, at: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < t.events.length && i < at; i++) {
    const e = t.events[i]!;
    if (e.ok && !e.skipped) out.push(e.name);
  }
  return out;
}

/**
 * Compile from warned/failing runs: the productive prefix before the first
 * warning, not only ≥3 happy traces.
 */
export function clusterFailureTraces(traces: StretchTrace[], minSupport = 3): Cluster[] {
  const warned = traces.filter((t) => (t.warnings?.length ?? 0) > 0 || t.firstWarningAt != null);
  const bySeq = new Map<string, { arr: string[]; traces: StretchTrace[] }>();
  for (const t of warned) {
    const at = t.firstWarningAt ?? t.warnings?.[0]?.at ?? t.events.length;
    const arr = namesBefore(t, at);
    if (arr.length < 3) continue;
    const key = arr.join("\0");
    const row = bySeq.get(key);
    if (row) row.traces.push(t);
    else bySeq.set(key, { arr, traces: [t] });
  }
  const clusters: Cluster[] = [];
  for (const row of bySeq.values()) {
    if (row.traces.length < minSupport) continue;
    clusters.push({ sequence: row.arr, traces: row.traces });
  }
  return clusters.sort((a, b) => b.traces.length - a.traces.length || b.sequence.length - a.sequence.length);
}

export function clusterTraces(traces: StretchTrace[], minSupport = 3): Cluster[] {
  const grams = ngrams(traces, minSupport, 3, 12);
  const fromNgrams: Cluster[] = [];
  for (const seq of grams) {
    if (fromNgrams.some((c) => isSubsequence(seq, c.sequence))) continue;
    const matching = traces.filter((t) => isContiguous(seq, names(t)));
    if (matching.length < minSupport) continue;
    fromNgrams.push({ sequence: seq, traces: matching });
  }
  if (fromNgrams.length) {
    return fromNgrams.sort((a, b) => b.sequence.length - a.sequence.length || b.traces.length - a.traces.length);
  }

  const bySeq = new Map<string, { arr: string[]; traces: StretchTrace[] }>();
  for (const t of traces) {
    const arr = names(t);
    const s = arr.join("\0");
    const row = bySeq.get(s);
    if (row) row.traces.push(t);
    else bySeq.set(s, { arr, traces: [t] });
  }
  const seqs = [...bySeq.values()];
  const parent = seqs.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  const union = (a: number, b: number) => {
    const pa = find(a);
    const pb = find(b);
    if (pa !== pb) parent[pa] = pb;
  };
  for (let i = 0; i < seqs.length; i++) {
    for (let j = i + 1; j < seqs.length; j++) {
      if (nearSeq(seqs[i]!.arr, seqs[j]!.arr)) union(i, j);
    }
  }
  const groups = new Map<number, StretchTrace[]>();
  for (let i = 0; i < seqs.length; i++) {
    const p = find(i);
    const g = groups.get(p) ?? [];
    g.push(...seqs[i]!.traces);
    groups.set(p, g);
  }
  const clusters: Cluster[] = [];
  for (const g of groups.values()) {
    if (g.length < minSupport) continue;
    const sequence = majoritySequence(g);
    if (sequence.length < 3 || sequence.length > 12) continue;
    clusters.push({ sequence, traces: g });
  }
  clusters.sort((a, b) => b.traces.length - a.traces.length || b.sequence.length - a.sequence.length);
  return clusters;
}

export function ngrams(traces: StretchTrace[], minSupport = 3, minLen = 3, maxLen = 12): string[][] {
  const counts = new Map<string, { seq: string[]; n: Set<string> }>();
  for (const t of traces) {
    const arr = names(t);
    for (let len = minLen; len <= Math.min(maxLen, arr.length); len++) {
      for (let i = 0; i + len <= arr.length; i++) {
        const seq = arr.slice(i, i + len);
        const key = seq.join("\0");
        const row = counts.get(key) ?? { seq, n: new Set() };
        row.n.add(t.id);
        counts.set(key, row);
      }
    }
  }
  return [...counts.values()]
    .filter((r) => r.n.size >= minSupport)
    .sort((a, b) => b.seq.length - a.seq.length || b.n.size - a.n.size)
    .map((r) => r.seq);
}
