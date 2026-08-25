import type { StretchTrace } from "@eden/ir";
import { CHECK_MIN_SUPPORT, isCheckName } from "@eden/ir";
import { commandShape, abstractShellGroup } from "../../core/src/shapes";

/**
 * The identity an event contributes to a mined sequence.
 *
 * Shell events all record as "Bash", so clustering on raw names made every
 * CLI stretch invisible to the compiler — three kubectl calls and three
 * unrelated greps looked identical. Shape-derived names (`Bash:kubectl.get.pods`)
 * give repetition a domain-general vocabulary: the binary's own words, no
 * vendor table. Non-shell events keep their name untouched.
 */
const SHELL_TOOLS = new Set(["Bash", "bash", "shell", "Shell"]);

/**
 * Variation-aware shell identities for the compile currently running.
 *
 * Built once per compileTraces call (buildShellNames) and consulted by every
 * name match — mining and alignment must agree on identities. Module-level
 * because compile is synchronous and never reentrant; the names() cache keys
 * on this map's identity so a growing trace set re-derives instead of serving
 * stale skeletons.
 */
let activeShellNames: Map<string, string> | undefined;

export function setActiveShellNames(m?: Map<string, string>): void {
  activeShellNames = m;
}

export function effectiveEventName(
  e: { name: string; args?: Record<string, unknown>; command?: string },
  shellNames?: Map<string, string>,
): string {
  if (!SHELL_TOOLS.has(e.name)) return e.name;
  const cmd = String(e.command ?? e.args?.command ?? "");
  const mapped = (shellNames ?? activeShellNames)?.get(cmd);
  if (mapped) return `${e.name}:${mapped}`;
  const shape = commandShape(cmd);
  return shape ? `${e.name}:${shape.name}` : e.name;
}

/**
 * Variation-aware shell identities for one compile.
 *
 * Peers vote on which positional tokens are structure and which are
 * parameters — but ONLY among events that occupy the same position in
 * structurally identical traces. Grouping by binary alone would let
 * `get pods|svc|deployments` (which vary across witnesses, yet are three
 * distinct sequence steps) collapse into one slot-ridden identity; ordinal
 * alignment keeps them separate while still turning the per-app pod name in
 * `kubectl logs <app> -n <ns>` into the slot it genuinely is.
 *
 * Assumption (documented limitation): witnesses replay a workflow in a
 * consistent step order. Shuffled step orders across traces are treated as
 * different coarse signatures and fall back to plain shape names.
 */
export function buildShellNames(traces: StretchTrace[]): Map<string, string> {
  const out = new Map<string, string>();
  interface ShellList {
    cmds: string[];
  }
  const buckets = new Map<string, ShellList[]>();
  for (const t of traces) {
    const cmds: string[] = [];
    for (const e of t.events) {
      if (!SHELL_TOOLS.has(e.name) || !e.ok || e.skipped) continue;
      const cmd = String((e.args as Record<string, unknown> | undefined)?.command ?? "");
      if (cmd) cmds.push(cmd);
    }
    if (!cmds.length) continue;
    const sig = cmds.map((c) => coarseShellKey(c)).join("\u0001");
    const list = { cmds };
    const b = buckets.get(sig);
    if (b) b.push(list);
    else buckets.set(sig, [list]);
  }
  for (const [, lists] of buckets) {
    if (lists.length < 2) continue;
    const width = lists[0]!.cmds.length;
    // Equal coarse signatures imply equal widths by construction; kept as a
    // guard anyway in case coarseShellKey ever widens.
    if (lists.some((l) => l.cmds.length !== width)) continue;
    for (let j = 0; j < width; j++) {
      const column = lists.map((l) => l.cmds[j]!);
      for (const [cmd, name] of abstractShellGroup(column)) {
        // The map is keyed by raw command across ALL buckets. A command
        // appearing under two different cohort compositions can receive two
        // different skeletons — last-write-wins fused unrelated steps and
        // split identical ones. On conflict, fall back to the plain shape
        // name: less parameterized identity beats a contested one.
        const prev = out.get(cmd);
        if (prev !== undefined && prev !== name) {
          out.delete(cmd);
          continue;
        }
        out.set(cmd, name);
      }
    }
  }
  return out;
}

/** Binary + first subcommand: the coarse key ordinal alignment buckets on. */
function coarseShellKey(cmd: string): string {
  const tokens = cmd.trim().split(/\s+/);
  const bin = tokens[0] ?? "";
  const sub1 = tokens[1] && !tokens[1].startsWith("-") ? tokens[1] : "";
  return `${bin}.${sub1}`;
}

export type Cluster = {
  sequence: string[];
  traces: StretchTrace[];
  /**
   * For failure clusters: per-trace index (into events) where the productive
   * prefix ends. Alignment must not look past it — post-warning occurrences
   * of the same tool would otherwise bind arguments from the wrong event.
   */
  cutAt?: number[];
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
const nameCache = new WeakMap<object, { sig: Map<string, string> | undefined; out: string[] }>();

function names(t: StretchTrace): string[] {
  const hit = nameCache.get(t);
  if (hit && hit.sig === activeShellNames) return hit.out;
  const out: string[] = [];
  for (const e of t.events) if (e.ok && !e.skipped) out.push(effectiveEventName(e));
  nameCache.set(t, { sig: activeShellNames, out });
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
    // Same decoration as happy-path mining: a shell event mined as bare
    // "Bash" could never align with "Bash:kubectl.get.pods" later in the
    // pipeline, so those clusters were silently dropped while their emitted
    // sequences advertised steps that do not exist.
    if (e.ok && !e.skipped) out.push(effectiveEventName(e));
  }
  return out;
}

/**
 * Compile from warned/failing runs: the productive prefix before the first
 * warning, not only ≥3 happy traces.
 */
export function clusterFailureTraces(traces: StretchTrace[], minSupport = 3): Cluster[] {
  const warned = traces.filter((t) => (t.warnings?.length ?? 0) > 0 || t.firstWarningAt != null);
  const bySeq = new Map<string, { arr: string[]; traces: StretchTrace[]; cuts: number[] }>();
  for (const t of warned) {
    const at = t.firstWarningAt ?? t.warnings?.[0]?.at ?? t.events.length;
    const arr = namesBefore(t, at);
    if (arr.length < 3) continue;
    const key = arr.join("\0");
    const row = bySeq.get(key);
    if (row) row.traces.push(t);
    else bySeq.set(key, { arr, traces: [t], cuts: [] });
    // Record WHERE this trace's productive prefix ends so alignment can match
    // against exactly those events. firstWarningAt indexes ALL events while
    // alignment counts only ok ones — without the boundary, a trace carrying
    // extra post-warning occurrences of the same tool binds arguments from
    // the wrong occurrence.
    const row2 = bySeq.get(key)!;
    row2.cuts.push(at);
  }
  const clusters: Cluster[] = [];
  for (const row of bySeq.values()) {
    if (row.traces.length < minSupport) continue;
    clusters.push({ sequence: row.arr, traces: row.traces, cutAt: row.cuts });
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
