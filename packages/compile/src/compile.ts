import type { Refusal, Step, StretchProgram, StretchTrace, TraceEvent, Binding, FromBinding } from "@eden/ir";
import { CHECK_MIN_SUPPORT, assertValid, canonicalize, eq, getPath, hashStretch, hashTrace, withVersion, minLlmReductionOf, failureModeOf, isUsableOutput, isWeakValue, whenToUseOf } from "@eden/ir";
import { isShellCommand } from "@eden/ir";
import { argKeys, bindSlotWitnesses, inferSchema, isCheckName, isIslandName, isMutating, isReadName, keyJaccard, remapBinding } from "./bind";
import { clusterFailureTraces, clusterTraces, effectiveEventName, buildShellNames, setActiveShellNames, autoMaxGram, envelopeTraces } from "./mine";
import { findForkedGroups, assembleForkProgram, forkWitnessTraces } from "./fork";
import { findHandoffGroups, assembleHandoffProgram, matchChildProgram } from "./handoff";
import { findComposeJoins, assembleComposeProgram, findWitnessedComposeSplits, sliceTracesToSeq, matchProgramBySequence } from "./compose";
import { normalizeTraces } from "./normalize";
import { inferCursorWalk, inferOffsetWalk, inferFilterPred, inferGroupKey, lookupArg, concatPageItems, collectLeaves, collectDeepTrees } from "./walk";
import { evalAssert } from "@eden/runtime";

export type CompileOpts = {
  minSupport?: number;
  allowExact?: boolean;
  minLlmReduction?: number;
  /**
   * Longest n-gram window the miner considers. Omitted (the default): chosen
   * from the input length distribution so ETL-class stretches compile whole
   * and desk-class stays at the 12 floor. An explicit value always wins.
   */
  maxGram?: number;
};

export type CompileResult = {
  programs: StretchProgram[];
  refusals: Refusal[];
};

function stretchName(sequence: string[]): string {
  const core = sequence.filter((n) => !isCheckName(n));
  const parts = core.length ? core : sequence;
  const raw =
    parts.length <= 2 ? parts.join("_") : `${parts[0]}_to_${parts[parts.length - 1]}`;
  return raw.replace(/[^A-Za-z0-9_]+/g, "_").slice(0, 48) || "stretch";
}

function stepId(name: string, used: Set<string>): string {
  const base = name.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_|_$/g, "") || "step";
  let id = base;
  let n = 2;
  while (used.has(id)) id = `${base}_${n++}`;
  used.add(id);
  return id;
}

function booleanAsserts(events: TraceEvent[]): Array<{ expr: string; onFail: "deopt" | "error" }> {
  const out: Array<{ expr: string; onFail: "deopt" | "error" }> = [];
  for (const key of ["ok", "verified", "valid", "success"]) {
    const hits = events.filter((e) => e.result && typeof e.result === "object" && key in (e.result as object));
    if (hits.length / Math.max(events.length, 1) < 0.8) continue;
    const truths = hits.filter((e) => (e.result as Record<string, unknown>)[key] === true);
    if (truths.length / hits.length >= 0.8) {
      out.push({ expr: `${key} == true`, onFail: key === "verified" ? "error" : "deopt" });
    }
  }
  return out;
}

function stableCanon(results: unknown[]): string[] {
  if (results.length < 2) return results.map((r) => canonicalize(r));
  if (!results.every((r) => r && typeof r === "object" && !Array.isArray(r))) {
    return results.map((r) => canonicalize(r));
  }
  const recs = results as Record<string, unknown>[];
  const keys = [...new Set(recs.flatMap((r) => Object.keys(r)))];
  const volatile = new Set<string>();
  for (const k of keys) {
    const vals = recs.map((r) => canonicalize(r[k]));
    if (new Set(vals).size === vals.length) volatile.add(k);
  }
  // Every field unique → the payload itself diverges (draft prose). Keep it.
  if (volatile.size === keys.length) return results.map((r) => canonicalize(r));
  return recs.map((r) => {
    const o: Record<string, unknown> = {};
    for (const k of keys) if (!volatile.has(k)) o[k] = r[k];
    return canonicalize(o);
  });
}

function divergeSameArgs(evs: TraceEvent[]): boolean {
  const groups = new Map<string, unknown[]>();
  for (const e of evs) {
    const k = cheapInputKey(e.args);
    const g = groups.get(k);
    if (g) g.push(e.result);
    else groups.set(k, [e.result]);
  }
  for (const results of groups.values()) {
    if (results.length < 2) continue;
    const canons = stableCanon(results);
    if (canons.some((c) => c !== canons[0])) return true;
  }
  return false;
}

/**
 * Whether this aligned tool is a model island, not a world step.
 *
 * Same-args / varying-results is how the world looks (`listItems` with `{q:"open"}`
 * returning different ids per witness). A list is not a model step. Islands stay
 * `isIslandName` (draft/reply/summarize/…) or non-read, non-mutating, non-check
 * glue that actually diverges. `isIslandName` wins so TicketShip `draftReply`
 * stays an island.
 */
function emitIsland(tool: string, evs: TraceEvent[]): boolean {
  if (isIslandName(tool)) return true;
  if (isReadName(tool) || isMutating(tool) || isCheckName(tool)) return false;
  return divergeSameArgs(evs);
}

/**
 * Scannable SKILL.md one-liner: when to call this island, not the sequence dump.
 * Deterministic from the judgment tool name and the tools it sits after.
 */
export function islandWhenToUse(tool: string, prior: readonly string[]): string {
  const after = prior.filter((n) => n.length > 0);
  const shown = after.length > 4 ? after.slice(-4) : after;
  const afterBit = shown.length ? ` after ${shown.join(" → ")}` : "";
  return `When the next step is a ${tool} judgment${afterBit} — one call, do not re-run the loop.`;
}

function aligned(traces: StretchTrace[], tool: string, nth = 0, cutAt?: number[]): { traces: StretchTrace[]; events: TraceEvent[] } {
  const tracesOut: StretchTrace[] = [];
  const events: TraceEvent[] = [];
  for (const [k, t] of traces.entries()) {
    // Match on the effective (shape-derived) name so a cluster mined from
    // `Bash:kubectl.get.pods` aligns with the actual shell events, while the
    // emitted step still calls the registry's real tool name. For failure
    // clusters the search stops at the trace's own warning cut: occurrences
    // after it are not part of the mined prefix.
    const bound = cutAt?.[k];
    let seen = 0;
    let hit: TraceEvent | undefined;
    for (let j = 0; j < t.events.length; j++) {
      if (bound !== undefined && j >= bound) break;
      const ev = t.events[j]!;
      if (!ev.ok || ev.skipped) continue;
      if (effectiveEventName(ev) !== tool) continue;
      if (seen === nth) {
        hit = ev;
        break;
      }
      seen++;
    }
    if (!hit) continue;
    tracesOut.push(t);
    events.push(hit);
  }
  // Fully-aligned clusters (synth500, ETL) keep the original array identity so
  // bindContext can extend priors incrementally instead of flattening again.
  if (tracesOut.length === traces.length) return { traces, events };
  return { traces: tracesOut, events };
}

function repeatingPeriod(seq: string[]): { start: number; unit: string[]; times: number; end: number } | null {  let best: { start: number; unit: string[]; times: number; end: number; score: number } | null = null;
  for (let p = 2; p <= Math.min(4, Math.floor(seq.length / 2)); p++) {
    for (let start = 0; start <= seq.length - p * 2; start++) {
      const unit = seq.slice(start, start + p);
      if (new Set(unit).size < 2) continue;
      let times = 0;
      let i = start;
      while (i + p <= seq.length && unit.every((n, j) => seq[i + j] === n)) {
        times++;
        i += p;
      }
      if (times >= 2) {
        const score = times * p;
        if (!best || score > best.score) best = { start, unit, times, end: i, score };
      }
    }
  }
  return best;
}

function collapseConsecutive(sequence: string[]): Array<{ tool: string; times: number; start: number }> {
  const out: Array<{ tool: string; times: number; start: number }> = [];
  for (let i = 0; i < sequence.length; i++) {
    const last = out.at(-1);
    if (last && last.tool === sequence[i]) last.times++;
    else out.push({ tool: sequence[i]!, times: 1, start: i });
  }
  return out;
}

/**
 * How many times `tool` repeats in THIS trace, as the run immediately following
 * `priorTool`'s first ok event. Clusters deliberately merge traces whose repeat
 * widths differ (nearSeq unions a 7-item fan-out with a 10-item one), so the
 * cluster-majority width cannot be used to bind the loop's `over` array: each
 * witness must bind against its own width. The compiled program does not care —
 * at replay the loop iterates whatever array the input actually produces.
 */
function traceRepeatRun(t: StretchTrace, tool: string, priorTool: string): number {
  const names = t.events.filter((e) => e.ok).map((e) => effectiveEventName(e));
  const runAfter = (p: number): number => {
    if (p < 0 || names[p + 1] !== tool) return 0;
    let n = 0;
    while (names[p + 1 + n] === tool) n++;
    return n;
  };
  const first = names.indexOf(priorTool);
  const head = runAfter(first);
  if (head >= 2) return head;
  const last = names.lastIndexOf(priorTool);
  return runAfter(last);
}

/**
 * Arrays on a prior result that could be a foreach source.
 *
 * Top-level arrays stay `path: ""`. Nested objects are walked to depth 3 so
 * GraphQL `{ data: { edges: [...] } }` (and similar one-or-two-level nests)
 * is visible. Array elements are not walked — a leftover sibling `more` next
 * to `hits` is a second candidate, never a nested slice of `hits`.
 */
const RESULT_ARRAY_MAX_DEPTH = 3;

function collectResultArrays(
  result: unknown,
  prefix = "",
  depth = 0,
): Array<{ path: string; arr: unknown[] }> {
  if (Array.isArray(result)) return [{ path: prefix, arr: result }];
  if (!result || typeof result !== "object") return [];
  const out: Array<{ path: string; arr: unknown[] }> = [];
  for (const [k, v] of Object.entries(result as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (Array.isArray(v)) {
      out.push({ path, arr: v });
      continue;
    }
    if (v && typeof v === "object" && !Array.isArray(v) && depth + 1 < RESULT_ARRAY_MAX_DEPTH) {
      out.push(...collectResultArrays(v, path, depth + 1));
    }
  }
  return out;
}

/**
 * Primitive fields that uniquely identify a loop item when the agent passes
 * `item.sku` (or similar) rather than the whole object or `item.id`.
 * Preference order is load-bearing: if several preferred fields equal the
 * same arg, pick the first rather than guessing among non-preferred keys.
 * Multiple non-preferred hits with no preferred field is ambiguous — refuse.
 */
const LOOP_ITEM_FIELDS = [
  "id",
  "sku",
  "qty",
  "warehouse",
  "key",
  "name",
  "title",
  "path",
  "email",
  "ns",
  "node",
  "versionId",
  "timezone",
  "tz",
  "segment",
  "sha",
  "host",
  "sev",
  "token",
  "cents",
  "person",
  "deptId",
  "level",
] as const;
const LOOP_ITEM_MAX_DEPTH = 3;

function lastSeg(path: string): string {
  const i = path.lastIndexOf(".");
  return i < 0 ? path : path.slice(i + 1);
}

function primitiveFieldHits(item: object, pred: (fv: unknown) => boolean, prefix = "", depth = 0): string[] {
  const hits: string[] = [];
  const nested: Array<[string, object]> = [];
  for (const [k, fv] of Object.entries(item as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (fv != null && typeof fv === "object" && !Array.isArray(fv)) {
      nested.push([path, fv as object]);
      continue;
    }
    if (fv == null || typeof fv === "object" || isWeakValue(fv)) continue;
    if (typeof fv !== "string" && typeof fv !== "number") continue;
    if (pred(fv)) hits.push(path);
  }
  if (depth + 1 < LOOP_ITEM_MAX_DEPTH) {
    for (const [path, fv] of nested) hits.push(...primitiveFieldHits(fv, pred, path, depth + 1));
  }
  return hits;
}

/**
 * Structural item-field bind. Arg-key last segment, then unique match, then
 * unique-across-array. LOOP_ITEM_FIELDS is a last-resort tie break only.
 */
function resolveItemField(
  hits: string[],
  key?: string,
  item?: unknown,
  siblings?: unknown[],
): string | null {
  if (!hits.length) return null;
  const keySeg = key ? lastSeg(key) : "";
  if (keySeg) {
    const byKey = hits.filter((h) => lastSeg(h) === keySeg);
    if (byKey.length === 1) return byKey[0]!;
  }
  if (hits.length === 1) return hits[0]!;
  if (siblings && siblings.length >= 2 && item !== undefined) {
    const uniqueHits = hits.filter((h) => {
      const mine = getPath(item, h);
      return siblings.filter((s) => eq(getPath(s, h), mine)).length === 1;
    });
    if (uniqueHits.length === 1) return uniqueHits[0]!;
    if (uniqueHits.length > 1) {
      if (keySeg) {
        const byKey = uniqueHits.filter((h) => lastSeg(h) === keySeg);
        if (byKey.length === 1) return byKey[0]!;
      }
      for (const f of LOOP_ITEM_FIELDS) {
        const matches = uniqueHits.filter((h) => lastSeg(h) === f);
        if (matches.length === 1) return matches[0]!;
      }
    }
  }
  for (const f of LOOP_ITEM_FIELDS) {
    const matches = hits.filter((h) => lastSeg(h) === f);
    if (matches.length === 1) return matches[0]!;
    if (matches.length > 1) return null;
  }
  return null;
}

function itemValuePath(
  item: unknown,
  v: unknown,
  key?: string,
  siblings?: unknown[],
): { path: string } | "skip" | "ambiguous" {
  if (eq(v, item)) return { path: "" };
  if (item == null || typeof item !== "object" || Array.isArray(item)) return "skip";
  if (v !== null && typeof v === "object") {
    const objHits: string[] = [];
    for (const [k, fv] of Object.entries(item as Record<string, unknown>)) {
      if (eq(fv, v)) objHits.push(k);
    }
    if (objHits.length === 1) return { path: objHits[0]! };
    if (objHits.length > 1) return "ambiguous";
  }
  const hits = primitiveFieldHits(item, (fv) => eq(v, fv));
  if (!hits.length) return "skip";
  const resolved = resolveItemField(hits, key, item, siblings);
  return resolved == null ? "ambiguous" : { path: resolved };
}

/**
 * An event matches a loop item when some args are the item or unique fields
 * of it. Two fields on the item (`cohort`+`pct`) are not a guess — each arg
 * resolves on its own. Two fields of the same item that equal one arg still
 * refuse (ambiguous).
 */
function itemsMatchLoop(arr: unknown[], loopEvs: TraceEvent[]): boolean {
  const n = Math.min(arr.length, loopEvs.length);
  if (n < 2) return false;
  for (let i = 0; i < n; i++) {
    const args = loopEvs[i]!.args ?? {};
    const item = arr[i];
    if (Object.values(args).some((v) => eq(v, item))) continue;
    let fromItem = false;
    for (const [k, v] of Object.entries(args)) {
      const hit = itemValuePath(item, v, k, arr);
      if (hit === "ambiguous") return false;
      if (hit !== "skip") fromItem = true;
    }
    if (!fromItem) return false;
  }
  return true;
}

function loopRunEvents(t: StretchTrace, tool: string, priorTool: string): TraceEvent[] {
  const okEvs = t.events.filter((e) => e.ok && !e.skipped);
  const runAfter = (p: number): TraceEvent[] => {
    const run: TraceEvent[] = [];
    for (let i = p + 1; i < okEvs.length && effectiveEventName(okEvs[i]!) === tool; i++) run.push(okEvs[i]!);
    return run;
  };
  const first = okEvs.findIndex((e) => effectiveEventName(e) === priorTool);
  if (first < 0) return [];
  const head = runAfter(first);
  if (head.length >= 2) return head;
  let last = -1;
  for (let i = 0; i < okEvs.length; i++) if (effectiveEventName(okEvs[i]!) === priorTool) last = i;
  return last >= 0 ? runAfter(last) : [];
}

type ArrayBind =
  | {
      path: string;
      slice?: { start: number; end: number };
      flatten?: boolean;
      filter?: string;
      nest?: string;
      unique?: string;
      sort?: string;
      deep?: string;
    }
  | { miss: { path: string; readSet: number; repeats: number } };

/**
 * Prefix slice is only legal when the walked items are ranked: every prefix
 * item has numeric `rank` 1..k, or the prefix is the top-k by numeric `score`.
 * Strings (grep hits) have neither — a stable string prefix is still a miss.
 */
function isRankedPrefix(arr: unknown[], k: number): boolean {
  if (k < 1 || arr.length < k) return false;
  const prefix = arr.slice(0, k);
  if (!prefix.every((x) => x && typeof x === "object" && !Array.isArray(x))) return false;
  const recs = prefix as Record<string, unknown>[];
  if (recs.every((r, i) => typeof r.rank === "number" && r.rank === i + 1)) return true;
  if (!arr.every((x) => x && typeof x === "object" && !Array.isArray(x) && typeof (x as Record<string, unknown>).score === "number")) {
    return false;
  }
  const scores = arr.map((x) => (x as Record<string, unknown>).score as number);
  const top = [...scores].sort((a, b) => b - a).slice(0, k);
  return scores.slice(0, k).every((s, i) => s === top[i]);
}

/**
 * Exact-width bind, or a witnessed stable prefix (top-k) as a slice.
 * A random / non-prefix subset of a longer array is a miss so diagnose
 * can refuse read_set_mismatch rather than guessing indices.
 *
 * A prefix of a longer array on the SAME prior step is only a slice when
 * the loop events actually walk that prefix AND the items are ranked
 * (search-topk). grep-12 / read-6 (odd indices, or a string prefix) is a
 * miss — never a guessed slice, and never `except` against a sibling leftover
 * array on that same step (`more`).
 */
function itemMatchesEvent(item: unknown, ev: TraceEvent): boolean {
  const args = ev.args ?? {};
  if (Object.values(args).some((v) => eq(v, item))) return true;
  let fromItem = false;
  for (const [k, v] of Object.entries(args)) {
    const hit = itemValuePath(item, v, k);
    if (hit === "ambiguous") return false;
    if (hit !== "skip") fromItem = true;
  }
  return fromItem;
}

function takenItemsInOrder(arr: unknown[], loopEvs: TraceEvent[]): unknown[] {
  const out: unknown[] = [];
  let j = 0;
  for (const item of arr) {
    if (j >= loopEvs.length) break;
    if (itemMatchesEvent(item, loopEvs[j]!)) {
      out.push(item);
      j++;
    }
  }
  return j === loopEvs.length ? out : [];
}

function arrayPrimitiveFields(arr: unknown[]): string[] {
  if (!arr.length || arr[0] == null || typeof arr[0] !== "object" || Array.isArray(arr[0])) return [];
  return primitiveFieldHits(arr[0] as object, () => true).filter((f) =>
    arr.every((it) => {
      const v = getPath(it, f);
      return v != null && typeof v !== "object";
    }),
  );
}

function uniqueByField(arr: unknown[], field: string): unknown[] {
  const seen = new Set<string>();
  const out: unknown[] = [];
  for (const item of arr) {
    const k = field ? canonicalize(getPath(item, field)) : canonicalize(item);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  return out;
}

function sortByExpr(arr: unknown[], expr: string): unknown[] {
  const desc = expr.startsWith("-");
  const field = desc ? expr.slice(1) : expr;
  return arr
    .map((item, i) => ({ item, i }))
    .sort((a, b) => {
      const av = getPath(a.item, field);
      const bv = getPath(b.item, field);
      let cmp = 0;
      if (typeof av === "number" && typeof bv === "number") cmp = av - bv;
      else cmp = String(av ?? "").localeCompare(String(bv ?? ""));
      const ordered = desc ? -cmp : cmp;
      return ordered !== 0 ? ordered : a.i - b.i;
    })
    .map((x) => x.item);
}

function sameItemOrder(a: unknown[], b: unknown[]): boolean {
  return a.length === b.length && a.every((x, i) => eq(x, b[i]));
}

function loopArgsHaveArray(loopEvs: TraceEvent[]): boolean {
  return loopEvs.some((e) => Object.values(e.args ?? {}).some((v) => Array.isArray(v) && v.length > 0));
}

function loopArgSegs(loopEvs: TraceEvent[]): Set<string> {
  const s = new Set<string>();
  for (const e of loopEvs) for (const k of Object.keys(e.args ?? {})) s.add(lastSeg(k));
  return s;
}

/** Unique: prefer the field the loop actually passed. */
function pickUniqueField(hits: string[], loopEvs: TraceEvent[]): string | null {
  if (hits.length === 1) return hits[0]!;
  if (!hits.length) return null;
  const args = loopArgSegs(loopEvs);
  const named = hits.filter((h) => args.has(lastSeg(h)));
  return named.length === 1 ? named[0]! : null;
}

/** Sort: prefer a key that is not the passed identity (prio, not id). */
function pickSortExpr(hits: string[], loopEvs: TraceEvent[]): string | null {
  if (hits.length === 1) return hits[0]!;
  if (!hits.length) return null;
  const args = loopArgSegs(loopEvs);
  const notArg = hits.filter((expr) => {
    const f = expr.startsWith("-") ? expr.slice(1) : expr;
    return !args.has(lastSeg(f));
  });
  return notArg.length === 1 ? notArg[0]! : null;
}

function findArrayBinding(t: StretchTrace, priorTool: string, need: number, loopEvs?: TraceEvent[]): ArrayBind | null {
  const priors = t.events.filter((e) => effectiveEventName(e) === priorTool && e.ok);
  const prior = priors[0];
  const arrays = collectResultArrays(prior?.result);
  if (loopEvs && loopEvs.length >= 2) {
    const matches: Array<{
      path: string;
      slice?: { start: number; end: number };
      flatten?: boolean;
      filter?: string;
      nest?: string;
      unique?: string;
      sort?: string;
      deep?: string;
    }> = [];
    for (const { path, arr } of arrays) {
      if (arr.length === need && itemsMatchLoop(arr, loopEvs)) matches.push({ path });
      else if (arr.length > need && itemsMatchLoop(arr.slice(0, need), loopEvs) && isRankedPrefix(arr, need)) {
        matches.push({ path, slice: { start: 0, end: need } });
      } else if (arr.length > need) {
        const taken = takenItemsInOrder(arr, loopEvs);
        const pred = inferFilterPred(arr, taken);
        if (pred) matches.push({ path, filter: pred });
      }
      if (arr.length > need) {
        const uniqueHits: string[] = [];
        if (!loopArgsHaveArray(loopEvs)) {
          for (const f of arrayPrimitiveFields(arr)) {
            const taken = uniqueByField(arr, f);
            if (taken.length >= arr.length) continue;
            if (taken.length === need && itemsMatchLoop(taken, loopEvs)) uniqueHits.push(f);
          }
          const ident = uniqueByField(arr, "");
          if (ident.length < arr.length && ident.length === need && itemsMatchLoop(ident, loopEvs)) {
            uniqueHits.push("");
          }
        }
        const uniquePick = pickUniqueField(uniqueHits, loopEvs);
        if (uniquePick !== null) matches.push({ path, unique: uniquePick });
      }
      if (arr.length === need) {
        const sortHits: string[] = [];
        for (const f of arrayPrimitiveFields(arr)) {
          for (const expr of [f, `-${f}`]) {
            const sorted = sortByExpr(arr, expr);
            if (sameItemOrder(sorted, arr)) continue;
            if (itemsMatchLoop(sorted, loopEvs)) sortHits.push(expr);
          }
        }
        const sortPick = pickSortExpr(sortHits, loopEvs);
        if (sortPick !== null) matches.push({ path, sort: sortPick });
      }
      if (arr.length >= 1 && arr.every((x) => x && typeof x === "object" && !Array.isArray(x))) {
        const rec = arr[0] as Record<string, unknown>;
        for (const k of Object.keys(rec)) {
          if (!arr.every((x) => Array.isArray((x as Record<string, unknown>)[k]))) continue;
          const concat = arr.flatMap((x) => (x as Record<string, unknown>)[k] as unknown[]);
          if (concat.length === need && itemsMatchLoop(concat, loopEvs)) matches.push({ path, nest: k });
        }
      }
    }
    const trees = collectDeepTrees(prior?.result);
    for (const tree of trees) {
      const leaves = collectLeaves(tree.node, tree.key);
      if (leaves.length === need && itemsMatchLoop(leaves, loopEvs)) {
        matches.push({ path: tree.path, deep: tree.key });
      }
    }
    if (matches.some((m) => m.deep)) {
      const kept = matches.filter((m) => !m.nest);
      matches.length = 0;
      matches.push(...kept);
    }
    // Filter / ranked prefix / one-level nest win over unique/sort so sentry
    // and search-topk are not stolen or refused as ambiguous.
    const base = matches.filter((m) => m.filter || m.slice || m.nest || m.flatten || (!m.unique && !m.sort && !m.deep));
    if (base.length === 1) return base[0]!;
    if (base.length > 1) return null;
    const extra = matches.filter((m) => m.unique !== undefined || m.sort || m.deep);
    if (extra.length === 1) return extra[0]!;
    if (matches.length === 1) return matches[0]!;
    if (matches.length > 1) return null;
    if (priors.length >= 2) {
      const firstArrays = collectResultArrays(priors[0]!.result);
      const flatHits: Array<{ path: string }> = [];
      for (const { path } of firstArrays) {
        const concat = concatPageItems(t, priorTool, path);
        if (concat.length === need && itemsMatchLoop(concat, loopEvs)) flatHits.push({ path });
      }
      if (flatHits.length === 1) return { path: flatHits[0]!.path, flatten: true };
      if (flatHits.length > 1) return null;
    }
    for (const { path, arr } of arrays) {
      if (arr.length > need && arr.length >= 2) {
        return { miss: { path, readSet: arr.length, repeats: need } };
      }
    }
    return null;
  }
  const exact = arrays.filter((a) => a.arr.length === need);
  if (exact.length === 1) return { path: exact[0]!.path };
  return null;
}

function inferLoopOver(
  traces: StretchTrace[],
  priorTool: string | undefined,
  tool: string,
  earlierTools: string[] = [],
): Binding | null {
  if (!priorTool || traces.length === 0) return null;
  let fromPrior: Binding | null = null;
  const hits: Array<{
    path: string;
    slice?: { start: number; end: number };
    flatten?: boolean;
    filter?: string;
    nest?: string;
    unique?: string;
    sort?: string;
    deep?: string;
  }> = [];
  let blocked = false;
  for (const t of traces) {
    const need = traceRepeatRun(t, tool, priorTool);
    if (need < 2) return null;
    const hit = findArrayBinding(t, priorTool, need, loopRunEvents(t, tool, priorTool));
    if (hit == null || "miss" in hit) {
      blocked = true;
      break;
    }
    hits.push(hit);
  }
  if (!blocked && hits.length === traces.length) {
    const path = hits[0]!.path;
    if (hits.every((h) => h.path === path)) {
      const slice = hits[0]!.slice;
      const flatten = hits[0]!.flatten;
      const filter = hits[0]!.filter;
      const unique = hits[0]!.unique;
      const sort = hits[0]!.sort;
      const deep = hits[0]!.deep;
      if (slice) {
        if (hits.every((h) => h.slice && h.slice.start === slice.start && h.slice.end === slice.end)) {
          return {
            kind: "transform",
            fn: "slice",
            expr: `${slice.start}:${slice.end}`,
            of: { kind: "from", step: priorTool, path },
          };
        }
      } else if (flatten) {
        if (hits.every((h) => h.flatten && h.path === path)) {
          return {
            kind: "transform",
            fn: "flatten",
            expr: path,
            of: { kind: "from", step: priorTool, path: "" },
          };
        }
      } else if (filter) {
        if (hits.every((h) => h.filter === filter)) {
          return {
            kind: "transform",
            fn: "filter",
            expr: filter,
            of: { kind: "from", step: priorTool, path },
          };
        }
      } else if (unique !== undefined) {
        if (hits.every((h) => h.unique === unique)) {
          return {
            kind: "transform",
            fn: "unique",
            expr: unique,
            of: { kind: "from", step: priorTool, path },
          };
        }
      } else if (sort) {
        if (hits.every((h) => h.sort === sort)) {
          return {
            kind: "transform",
            fn: "sort",
            expr: sort,
            of: { kind: "from", step: priorTool, path },
          };
        }
      } else if (deep) {
        if (hits.every((h) => h.deep === deep)) {
          return {
            kind: "transform",
            fn: "flatten",
            expr: `deep:${deep}`,
            of: { kind: "from", step: priorTool, path },
          };
        }
      } else if (hits[0]!.nest) {
        const nest = hits[0]!.nest;
        if (hits.every((h) => h.nest === nest)) {
          return {
            kind: "transform",
            fn: "flatten",
            expr: nest,
            of: { kind: "from", step: priorTool, path },
          };
        }
      } else if (!hits.some((h) => h.slice || h.flatten || h.filter || h.nest || h.unique !== undefined || h.sort || h.deep)) {
        fromPrior = { kind: "from", step: priorTool, path };
      }
    }
  }
  // Zip before a one-array exact: lockstep sku×price explains args a single
  // side cannot. Chunk after zip. Earlier-tool exact (list people, then teams,
  // then foreach people) before except, so a join is not mined as set-diff.
  const zipChunk = inferZipOrChunk(traces, earlierTools, priorTool, tool);
  if (zipChunk && zipChunk.kind === "transform" && zipChunk.fn === "zip") return zipChunk;
  if (fromPrior) return fromPrior;
  if (zipChunk) return zipChunk;
  const earlier = inferLoopOverEarlier(traces, earlierTools, priorTool, tool);
  if (earlier) return earlier;
  const grouped = inferGroupOver(traces, earlierTools, priorTool, tool);
  if (grouped) return grouped;
  return inferExceptOver(traces, earlierTools, priorTool, tool);
}

function inferLoopOverEarlier(
  traces: StretchTrace[],
  earlierTools: string[],
  priorTool: string | undefined,
  tool: string,
): Binding | null {
  const sources = [...new Set(earlierTools.filter((n) => n && n !== priorTool))];
  let agreed: Binding | null = null;
  for (const src of sources) {
    const paths: string[] = [];
    let ok = true;
    for (const t of traces) {
      const need = traceRepeatRun(t, tool, priorTool ?? src);
      if (need < 2) {
        ok = false;
        break;
      }
      const hit = findArrayBinding(t, src, need, loopRunEvents(t, tool, priorTool ?? src));
      if (hit == null || "miss" in hit || hit.flatten || hit.filter || hit.slice || hit.nest || hit.unique !== undefined || hit.sort || hit.deep) {
        ok = false;
        break;
      }
      paths.push(hit.path);
    }
    if (!ok || paths.length !== traces.length || paths.some((p) => p !== paths[0])) continue;
    const b: Binding = { kind: "from", step: src, path: paths[0]! };
    if (agreed && JSON.stringify(agreed) !== JSON.stringify(b)) return null;
    agreed = b;
  }
  return agreed;
}

function inferGroupOver(
  traces: StretchTrace[],
  earlierTools: string[],
  priorTool: string | undefined,
  tool: string,
): Binding | null {
  const sources = [...new Set([priorTool, ...earlierTools].filter((n): n is string => Boolean(n)))];
  let agreed: Binding | null = null;
  for (const src of sources) {
    let local: Binding | null = null;
    let ok = true;
    for (const t of traces) {
      const need = traceRepeatRun(t, tool, priorTool ?? src);
      const loopEvs = loopRunEvents(t, tool, priorTool ?? src);
      if (need < 2 || loopEvs.length !== need) {
        ok = false;
        break;
      }
      const prior = t.events.find((e) => e.ok && effectiveEventName(e) === src);
      let hit: Binding | null = null;
      for (const { path, arr } of collectResultArrays(prior?.result)) {
        const groups: Array<{ items: unknown[] }> = [];
        for (const ev of loopEvs) {
          const raw = ev.args?.items ?? ev.args?.group ?? ev.args?.rows;
          if (!Array.isArray(raw)) {
            hit = null;
            break;
          }
          groups.push({ items: raw });
        }
        if (groups.length !== need) continue;
        const field = inferGroupKey(arr, groups);
        if (!field) continue;
        hit = {
          kind: "transform",
          fn: "group",
          expr: field,
          of: { kind: "from", step: src, path },
        };
      }
      if (!hit) {
        ok = false;
        break;
      }
      if (!local) local = hit;
      else if (JSON.stringify(local) !== JSON.stringify(hit)) {
        ok = false;
        break;
      }
    }
    if (!ok || !local) continue;
    if (agreed && JSON.stringify(agreed) !== JSON.stringify(local)) return null;
    agreed = local;
  }
  return agreed;
}

function inferZipOrChunk(
  traces: StretchTrace[],
  earlierTools: string[],
  priorTool: string | undefined,
  tool: string,
): Binding | null {
  if (!priorTool) return null;
  const sources = [...new Set(earlierTools.filter((n) => n && n !== priorTool))];
  // zip: lockstep two arrays of equal length
  if (sources.length) {
    let zip: Binding | null = null;
    let zipOk = true;
    for (const t of traces) {
      const need = traceRepeatRun(t, tool, priorTool);
      const loopEvs = loopRunEvents(t, tool, priorTool);
      if (need < 2 || loopEvs.length !== need) {
        zipOk = false;
        break;
      }
      const rightEv = t.events.find((e) => e.ok && effectiveEventName(e) === priorTool);
      const rightArrays = collectResultArrays(rightEv?.result).filter((a) => a.arr.length === need);
      let local: Binding | null = null;
      for (const src of sources) {
        const leftEv = t.events.find((e) => e.ok && effectiveEventName(e) === src);
        const leftArrays = collectResultArrays(leftEv?.result).filter((a) => a.arr.length === need);
        for (const L of leftArrays) {
          for (const R of rightArrays) {
            const zipped = L.arr.map((a, i) => ({ left: a, right: R.arr[i] }));
            if (!itemsMatchLoop(zipped, loopEvs)) continue;
            const b: Binding = {
              kind: "transform",
              fn: "zip",
              expr: R.path ? `${priorTool}.${R.path}` : priorTool,
              of: { kind: "from", step: src, path: L.path },
            };
            if (local && JSON.stringify(local) !== JSON.stringify(b)) {
              local = null;
              break;
            }
            local = b;
          }
        }
      }
      if (!local) {
        zipOk = false;
        break;
      }
      if (!zip) zip = local;
      else if (JSON.stringify(zip) !== JSON.stringify(local)) {
        zipOk = false;
        break;
      }
    }
    if (zipOk && zip) return zip;
  }
  // chunk: consecutive groups of a prior array
  let chunk: Binding | null = null;
  for (const t of traces) {
    const need = traceRepeatRun(t, tool, priorTool);
    const loopEvs = loopRunEvents(t, tool, priorTool);
    if (need < 2 || loopEvs.length !== need) return chunk;
    const prior = t.events.find((e) => e.ok && effectiveEventName(e) === priorTool);
    let local: Binding | null = null;
    for (const { path, arr } of collectResultArrays(prior?.result)) {
      if (arr.length < need * 2) continue;
      const size = Math.round(arr.length / need);
      if (size < 2) continue;
      const groups: unknown[][] = [];
      for (let i = 0; i < arr.length; i += size) groups.push(arr.slice(i, i + size));
      if (groups.length !== need) continue;
      const asItems = groups;
      if (!itemsMatchLoop(asItems, loopEvs)) continue;
      local = {
        kind: "transform",
        fn: "chunk",
        expr: String(size),
        of: { kind: "from", step: priorTool, path },
      };
    }
    if (!local) return null;
    if (!chunk) chunk = local;
    else if (JSON.stringify(chunk) !== JSON.stringify(local)) return null;
  }
  return chunk;
}

/**
 * Set-difference foreach: walk A\B where A and B come from TWO DIFFERENT
 * prior tools (listDesired.items except listCurrent.items). Never minus a
 * sibling leftover array on the same step.
 */
function inferExceptOver(
  traces: StretchTrace[],
  earlierTools: string[],
  exclTool: string,
  bodyTool: string,
): Binding | null {
  const sources = [...new Set(earlierTools.filter((n) => n && n !== exclTool))];
  if (!sources.length || !exclTool) return null;
  type Cand = { srcTool: string; srcPath: string; exclPath: string };
  let agreed: Cand | null = null;
  for (const t of traces) {
    const need = traceRepeatRun(t, bodyTool, exclTool);
    if (need < 2) return null;
    const loopEvs = loopRunEvents(t, bodyTool, exclTool);
    const exclPrior = t.events.find((e) => effectiveEventName(e) === exclTool && e.ok);
    const exclArrays = collectResultArrays(exclPrior?.result);
    const hits: Cand[] = [];
    const seen = new Set<string>();
    for (const srcTool of sources) {
      const srcPrior = t.events.find((e) => effectiveEventName(e) === srcTool && e.ok);
      for (const src of collectResultArrays(srcPrior?.result)) {
        for (const excl of exclArrays) {
          const diff = exceptItems(src.arr, excl.arr);
          if (diff.length !== need || !itemsMatchLoop(diff, loopEvs)) continue;
          const key = `${srcTool}\0${src.path}\0${excl.path}`;
          if (seen.has(key)) continue;
          seen.add(key);
          hits.push({ srcTool, srcPath: src.path, exclPath: excl.path });
        }
      }
    }
    if (hits.length !== 1) return null;
    const pick = hits[0]!;
    if (!agreed) agreed = pick;
    else if (agreed.srcTool !== pick.srcTool || agreed.srcPath !== pick.srcPath || agreed.exclPath !== pick.exclPath) {
      return null;
    }
  }
  if (!agreed) return null;
  const expr = agreed.exclPath ? `${exclTool}.${agreed.exclPath}` : exclTool;
  return {
    kind: "transform",
    fn: "except",
    expr,
    of: { kind: "from", step: agreed.srcTool, path: agreed.srcPath },
  };
}

function exceptItems(source: unknown[], exclusion: unknown[]): unknown[] {
  return source.filter((s) => !exclusion.some((e) => sameLoopIdentity(s, e)));
}

function sameLoopIdentity(a: unknown, b: unknown): boolean {
  if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    const ida = (a as Record<string, unknown>).id;
    const idb = (b as Record<string, unknown>).id;
    if (ida !== undefined && idb !== undefined) return eq(ida, idb);
  }
  return eq(a, b) || canonicalize(a) === canonicalize(b);
}

function diagnoseUnboundForeach(
  traces: StretchTrace[],
  sequence: string[],
  priorTool: string | undefined,
  tool: string,
  times: number,
): Refusal {
  const reason = `${tool} repeats ${times}x without a bindable foreach`;
  if (!priorTool) {
    return {
      sequence,
      reason,
      slot: tool,
      code: "unbound_foreach",
      repeats: times,
      hint: `${tool} repeated ${times} times with no prior read to bind as the loop source. Return one array of the items the loop will walk.`,
    };
  }
  for (const t of traces) {
    const need = traceRepeatRun(t, tool, priorTool);
    if (need < 2) continue;
    const hit = findArrayBinding(t, priorTool, need, loopRunEvents(t, tool, priorTool));
    if (hit && "miss" in hit) {
      const { readSet, repeats } = hit.miss;
      return {
        sequence,
        reason,
        slot: tool,
        code: "read_set_mismatch",
        readSet,
        repeats,
        hint: `${priorTool} returned ${readSet}; ${tool} ran ${repeats} times. Expose the full array the loop iterates, or iterate once per item.`,
      };
    }
    const prior = t.events.find((e) => effectiveEventName(e) === priorTool && e.ok);
    const arrays = collectResultArrays(prior?.result);
    const other = arrays.find((a) => a.arr.length !== need && a.arr.length > 0);
    if (other) {
      return {
        sequence,
        reason,
        slot: tool,
        code: "read_set_mismatch",
        readSet: other.arr.length,
        repeats: need,
        hint: `${priorTool} returned ${other.arr.length}; ${tool} ran ${need} times. Expose the full array the loop iterates, or iterate once per item.`,
      };
    }
  }
  return {
    sequence,
    reason,
    slot: tool,
    code: "unbound_foreach",
    repeats: times,
    hint: `${tool} repeated ${times} times but no prior step returned an array of that length. Return one array of the items the loop will walk.`,
  };
}

/**
 * Exact-width variant for period loops: the cluster's majority sequence fixes
 * the width, and period alignment already assumes every witness ran the same
 * number of unit repetitions.
 */
function inferLoopOverExact(
  traces: StretchTrace[],
  priorTool: string | undefined,
  times: number,
  _bodyTool?: string,
): Binding | null {
  if (!priorTool || times < 2) return null;
  const paths: string[] = [];
  for (const t of traces) {
    const hit = findArrayBinding(t, priorTool, times);
    if (hit == null || "miss" in hit || hit.flatten || hit.filter || hit.slice || hit.unique !== undefined || hit.sort || hit.deep) {
      paths.length = 0;
      break;
    }
    paths.push(hit.path);
  }
  if (paths.length === traces.length && paths.every((p) => p === paths[0])) {
    return { kind: "from", step: priorTool, path: paths[0]! };
  }
  const flats: string[] = [];
  for (const t of traces) {
    const priors = t.events.filter((e) => e.ok && effectiveEventName(e) === priorTool);
    if (priors.length < 2) return null;
    const arrays = collectResultArrays(priors[0]!.result);
    const hits = arrays.filter((a) => concatPageItems(t, priorTool, a.path).length === times);
    if (hits.length !== 1) return null;
    flats.push(hits[0]!.path);
  }
  if (flats.length === traces.length && flats.every((p) => p === flats[0])) {
    return {
      kind: "transform",
      fn: "flatten",
      expr: flats[0]!,
      of: { kind: "from", step: priorTool, path: "" },
    };
  }
  return null;
}

/**
 * The registry name a cluster identity actually executes against.
 *
 * Shell-derived clusters carry decorated identities (`Bash:kubectl.get.pods`)
 * while the registry only knows "Bash". Every emission path must rewrite —
 * the loop branches used to skip this and ship programs that crashed at
 * replay with `unknown tool`.
 */
function realToolOf(traces: StretchTrace[], tool: string, nth = 0): string {
  return aligned(traces, tool, nth).events[0]?.name ?? tool;
}

function parseSliceExpr(expr: string): { start: number; end: number } | null {
  const m = /^(\d+):(\d+)$/.exec(expr.trim());
  if (!m) return null;
  return { start: Number(m[1]), end: Number(m[2]) };
}

function itemsFromOver(t: StretchTrace, priorTool: string, over: Binding): unknown[] {
  if (over.kind === "transform" && over.fn === "slice") {
    const inner = itemsFromOver(t, priorTool, over.of);
    const parsed = parseSliceExpr(over.expr);
    if (!parsed) return [];
    return inner.slice(parsed.start, parsed.end);
  }
  if (over.kind === "transform" && over.fn === "except") {
    const inner = itemsFromBinding(t, over.of);
    const excl = itemsFromExceptExpr(t, over.expr);
    return exceptItems(inner, excl);
  }
  if (over.kind === "transform" && over.fn === "flatten") {
    if (over.expr.trim().startsWith("deep:")) {
      const key = over.expr.trim().slice("deep:".length);
      if (over.of.kind === "from") {
        const from = over.of;
        const prior = t.events.find((e) => effectiveEventName(e) === from.step && e.ok);
        const root = from.path ? getPath(prior?.result, from.path) : prior?.result;
        return collectLeaves(root, key);
      }
      const inner = itemsFromOver(t, priorTool, over.of);
      return inner.flatMap((n) => collectLeaves(n, key));
    }
    if (over.of.kind === "from" && !over.of.path) {
      const from = over.of;
      const evs = t.events.filter((e) => effectiveEventName(e) === from.step && e.ok);
      const path = over.expr.trim();
      return evs.flatMap((e) => {
        const part = path ? getPath(e.result, path) : e.result;
        return Array.isArray(part) ? part : [];
      });
    }
    const inner = itemsFromOver(t, priorTool, over.of);
    const path = over.expr.trim();
    return inner.flatMap((item) => {
      const part = path ? getPath(item, path) : item;
      return Array.isArray(part) ? part : [];
    });
  }
  if (over.kind === "transform" && over.fn === "filter") {
    const inner = itemsFromOver(t, priorTool, over.of);
    return inner.filter((item) => {
      try {
        return evalAssert(over.expr, item, (t.input ?? {}) as Record<string, unknown>, { get: () => undefined });
      } catch {
        return false;
      }
    });
  }
  if (over.kind === "transform" && over.fn === "chunk") {
    const inner = itemsFromOver(t, priorTool, over.of);
    const n = Number(over.expr.trim());
    if (!Number.isInteger(n) || n < 2) return [];
    const out: unknown[][] = [];
    for (let i = 0; i < inner.length; i += n) out.push(inner.slice(i, i + n));
    return out;
  }
  if (over.kind === "transform" && over.fn === "zip") {
    const left = itemsFromOver(t, priorTool, over.of);
    const right = itemsFromExceptExpr(t, over.expr);
    if (left.length !== right.length) return [];
    return left.map((a, i) => ({ left: a, right: right[i] }));
  }
  if (over.kind === "transform" && over.fn === "group") {
    const inner = itemsFromOver(t, priorTool, over.of);
    const field = over.expr.trim();
    const order: string[] = [];
    const groups = new Map<string, unknown[]>();
    for (const item of inner) {
      const raw = getPath(item, field);
      const k = canonicalize(raw);
      if (!groups.has(k)) {
        groups.set(k, []);
        order.push(k);
      }
      groups.get(k)!.push(item);
    }
    return order.map((k) => {
      const items = groups.get(k)!;
      return { key: getPath(items[0], field), items };
    });
  }
  if (over.kind === "transform" && over.fn === "unique") {
    return uniqueByField(itemsFromOver(t, priorTool, over.of), over.expr.trim());
  }
  if (over.kind === "transform" && over.fn === "sort") {
    return sortByExpr(itemsFromOver(t, priorTool, over.of), over.expr.trim());
  }
  return itemsFromBinding(t, over);
}

function itemsFromBinding(t: StretchTrace, over: Binding): unknown[] {
  if (over.kind !== "from") return [];
  const prior = t.events.find((e) => effectiveEventName(e) === over.step && e.ok);
  const raw = over.path ? getPath(prior?.result, over.path) : prior?.result;
  return Array.isArray(raw) ? raw : [];
}

function itemsFromExceptExpr(t: StretchTrace, expr: string): unknown[] {
  const raw = expr.trim();
  const dot = raw.indexOf(".");
  const step = dot < 0 ? raw : raw.slice(0, dot);
  const path = dot < 0 ? "" : raw.slice(dot + 1);
  const prior = t.events.find((e) => effectiveEventName(e) === step && e.ok);
  const val = path ? getPath(prior?.result, path) : prior?.result;
  return Array.isArray(val) ? val : [];
}

function argsIdentical(evs: TraceEvent[]): boolean {
  if (evs.length < 2) return false;
  const k0 = cheapInputKey(evs[0]!.args ?? {});
  return evs.every((e) => cheapInputKey(e.args ?? {}) === k0);
}

const POLL_FIELDS = ["ready", "done", "complete", "available", "succeeded", "ok", "success"] as const;

function pollUntilExpr(evs: TraceEvent[]): string | null {
  if (evs.length < 2) return null;
  const last = evs.at(-1)?.result;
  if (!last || typeof last !== "object" || Array.isArray(last)) return null;
  const earlier = evs.slice(0, -1);
  const rec = last as Record<string, unknown>;
  const keys: string[] = [];
  for (const k of POLL_FIELDS) if (k in rec) keys.push(k);
  for (const k of Object.keys(rec)) if (!keys.includes(k)) keys.push(k);
  for (const key of keys) {
    const lv = rec[key];
    if (typeof lv !== "boolean" && typeof lv !== "string") continue;
    const earlierVals = earlier.map((e) => {
      const r = e.result;
      if (!r || typeof r !== "object" || Array.isArray(r)) return undefined;
      return (r as Record<string, unknown>)[key];
    });
    if (earlierVals.some((v) => v === undefined)) continue;
    if (!earlierVals.every((v) => eq(v, earlierVals[0]))) continue;
    if (eq(earlierVals[0], lv)) continue;
    return `${key} == ${JSON.stringify(lv)}`;
  }
  return null;
}

function consecutiveToolRun(t: StretchTrace, tool: string, priorTool?: string): TraceEvent[] {
  if (priorTool) return loopRunEvents(t, tool, priorTool);
  const okEvs = t.events.filter((e) => e.ok && !e.skipped);
  const start = okEvs.findIndex((e) => effectiveEventName(e) === tool);
  if (start < 0) return [];
  const run: TraceEvent[] = [];
  for (let i = start; i < okEvs.length && effectiveEventName(okEvs[i]!) === tool; i++) run.push(okEvs[i]!);
  return run;
}

function inferPoll(
  traces: StretchTrace[],
  tool: string,
  priorTool: string | undefined,
  times: number,
): { until: string; maxIters: number } | null {
  if (times < 2 || traces.length === 0) return null;
  let until: string | null = null;
  let maxIters = 0;
  for (const t of traces) {
    const run = consecutiveToolRun(t, tool, priorTool);
    if (run.length < 2) return null;
    maxIters = Math.max(maxIters, run.length);
    if (!argsIdentical(run)) return null;
    const expr = pollUntilExpr(run);
    if (!expr) return null;
    if (until == null) until = expr;
    else if (until !== expr) return null;
  }
  return until ? { until, maxIters } : null;
}

function retryUntilExpr(attempts: TraceEvent[]): string | null {
  const last = attempts.at(-1);
  if (!last?.ok) return null;
  const rec =
    last.result && typeof last.result === "object" && !Array.isArray(last.result)
      ? (last.result as Record<string, unknown>)
      : null;
  if (!rec) return "ok == true";
  for (const key of Object.keys(rec)) {
    if (rec[key] !== true) continue;
    const priorFalse = attempts.slice(0, -1).every((e) => {
      const r = e.result;
      if (!r || typeof r !== "object" || Array.isArray(r)) return true;
      return (r as Record<string, unknown>)[key] !== true;
    });
    if (priorFalse) return `${key} == true`;
  }
  return "ok == true";
}

/**
 * Failed attempts then one success, same args. Cluster names() skip !ok so
 * this is a times===1 tool with retry evidence still on the trace.
 */
function inferRetry(traces: StretchTrace[], tool: string): { until: string; maxIters: number } | null {
  if (!traces.length) return null;
  let until: string | null = null;
  let maxIters = 0;
  for (const t of traces) {
    const attempts = t.events.filter((e) => !e.skipped && effectiveEventName(e) === tool);
    if (attempts.length < 2) return null;
    const last = attempts.at(-1)!;
    if (!last.ok) return null;
    const fails = attempts.slice(0, -1);
    if (!fails.length || fails.some((e) => e.ok)) return null;
    if (!argsIdentical(attempts)) return null;
    maxIters = Math.max(maxIters, attempts.length);
    const expr = retryUntilExpr(attempts);
    if (!expr) return null;
    if (until == null) until = expr;
    else if (until !== expr) return null;
  }
  return until ? { until, maxIters } : null;
}

type LoopArgsOpts = {
  outer?: { over: Binding; priorTool: string };
  priorIds?: string[];
  mutating?: boolean;
  allowExact?: boolean;
  earlierTools?: string[];
};

function overWalkStep(over: Binding): string | null {
  if (over.kind === "from") return over.step;
  if (over.kind === "transform") return overWalkStep(over.of);
  return null;
}

function inferLookupBinding(
  traces: StretchTrace[],
  tool: string,
  key: string,
  over: Binding,
  priorTool: string,
  earlierTools: string[],
): Binding | null {
  const walked = overWalkStep(over);
  const sources = [...new Set([...earlierTools, priorTool].filter((n) => n && n !== walked))];
  if (!sources.length) return null;
  let agreed: Binding | null = null;
  for (const t of traces) {
    const items = itemsFromOver(t, priorTool, over);
    const evsAll = t.events.filter((e) => effectiveEventName(e) === tool && e.ok);
    const evs =
      items.length && evsAll.length > items.length && evsAll.length % items.length === 0
        ? evsAll.slice(0, items.length)
        : evsAll;
    if (items.length !== evs.length || items.length < 2) return null;
    const locals: Binding[] = [];
    for (const src of sources) {
      const ev = t.events.find((e) => e.ok && effectiveEventName(e) === src);
      for (const { path, arr } of collectResultArrays(ev?.result)) {
        let hit: ReturnType<typeof lookupArg> | null = null;
        let ok = true;
        for (let i = 0; i < items.length; i++) {
          const row = lookupArg(arr, items[i], evs[i]!.args?.[key]);
          if (!row) {
            ok = false;
            break;
          }
          if (!hit) hit = row;
          else if (hit.joinField !== row.joinField || hit.itemPath !== row.itemPath || hit.wantPath !== row.wantPath) {
            ok = false;
            break;
          }
        }
        if (!ok || !hit) continue;
        locals.push({
          kind: "transform",
          fn: "jsonpath",
          expr: hit.wantPath,
          of: {
            kind: "transform",
            fn: "lookup",
            expr: `${hit.joinField}=item.${hit.itemPath}`,
            of: { kind: "from", step: src, path },
          },
        });
      }
    }
    if (locals.length !== 1) return null;
    const local = locals[0]!;
    if (!agreed) agreed = local;
    else if (JSON.stringify(agreed) !== JSON.stringify(local)) return null;
  }
  return agreed;
}

function loopItemArgs(
  traces: StretchTrace[],
  tool: string,
  priorTool: string,
  over: Binding,
  opts?: LoopArgsOpts,
): Record<string, Binding> | null {
  const keyHits = new Map<string, Binding>();
  const allKeys = new Set<string>();
  for (const t of traces) {
    const items = itemsFromOver(t, priorTool, over);
    const evsAll = t.events.filter((e) => effectiveEventName(e) === tool && e.ok);
    const evs =
      items.length && evsAll.length > items.length && evsAll.length % items.length === 0
        ? evsAll.slice(0, items.length)
        : evsAll;
    if (items.length !== evs.length) return null;
    for (let i = 0; i < evs.length; i++) {
      const args = evs[i]!.args ?? {};
      const item = items[i];
      for (const [k, v] of Object.entries(args)) {
        allKeys.add(k);
        const hit = itemValuePath(item, v, k, items);
        if (hit === "skip") continue;
        if (hit === "ambiguous") return null;
        const prev = keyHits.get(k);
        const next: Binding = { kind: "from", step: "item", path: hit.path };
        if (prev !== undefined && (prev.kind !== "from" || prev.step !== "item" || prev.path !== hit.path)) return null;
        keyHits.set(k, next);
      }
    }
  }
  if (opts?.earlierTools?.length) {
    for (const k of allKeys) {
      if (keyHits.has(k)) continue;
      const bound = inferLookupBinding(traces, tool, k, over, priorTool, opts.earlierTools);
      if (bound) keyHits.set(k, bound);
    }
  }
  if (opts?.outer) {
    for (const k of allKeys) {
      if (keyHits.has(k)) continue;
      const path = bindFromOuterItem(traces, tool, k, opts.outer);
      if (path == null) continue;
      keyHits.set(k, { kind: "from", step: "outer", path });
    }
  }
  const priorIds = opts?.priorIds ?? opts?.earlierTools ?? [];
  for (const k of allKeys) {
    if (keyHits.has(k)) continue;
    const vals: unknown[] = [];
    for (const t of traces) {
      const items = itemsFromOver(t, priorTool, over);
      const evsAll = t.events.filter((e) => effectiveEventName(e) === tool && e.ok);
      const evs =
        items.length && evsAll.length > items.length && evsAll.length % items.length === 0
          ? evsAll.slice(0, items.length)
          : evsAll;
      if (!evs.length) return null;
      const v0 = evs[0]!.args?.[k];
      if (!evs.every((e) => eq(e.args?.[k], v0))) return null;
      vals.push(v0);
    }
    const bound = bindSlotWitnesses(vals, traces, priorIds, {
      mutating: opts?.mutating ?? false,
      allowExact: opts?.allowExact ?? false,
      shell: isShellCommand(tool, k),
    });
    if (!bound.ok) continue;
    keyHits.set(k, bound.binding);
  }
  if (!keyHits.size) return null;
  const args: Record<string, Binding> = {};
  for (const [k, b] of keyHits) args[k] = b;
  return args;
}

function bindFromOuterItem(
  traces: StretchTrace[],
  tool: string,
  key: string,
  outer: { over: Binding; priorTool: string },
): string | null {
  let path: string | undefined;
  for (const t of traces) {
    const outerItems = itemsFromOver(t, outer.priorTool, outer.over);
    const evs = t.events.filter((e) => effectiveEventName(e) === tool && e.ok);
    if (outerItems.length < 2 || evs.length < 2 || evs.length % outerItems.length !== 0) return null;
    const w = evs.length / outerItems.length;
    for (let oi = 0; oi < outerItems.length; oi++) {
      for (let j = 0; j < w; j++) {
        const ev = evs[oi * w + j]!;
        const hit = itemValuePath(outerItems[oi], ev.args?.[key], key, outerItems);
        if (hit === "skip" || hit === "ambiguous") return null;
        if (path === undefined) path = hit.path;
        else if (path !== hit.path) return null;
      }
    }
  }
  return path ?? null;
}

type EmittedLoop = { loopId: string; bodyTool: string; priorTool: string; over?: Binding };

/**
 * After a foreach, the runtime stores the collected body results on the loop
 * step. A following merge/write that passed that array (what the witnesses did)
 * binds `from` the loop — not a guessed literal, and not unbound.
 */
function bindFromLoopCollected(
  traces: StretchTrace[],
  values: unknown[],
  loops: readonly EmittedLoop[],
): Binding | null {
  if (!loops.length || values.length !== traces.length || !values.length) return null;
  for (let li = loops.length - 1; li >= 0; li--) {
    const loop = loops[li]!;
    let ok = true;
    for (let i = 0; i < traces.length; i++) {
      const collected = loopRunEvents(traces[i]!, loop.bodyTool, loop.priorTool).map((e) => e.result);
      if (collected.length < 2 || !eq(values[i], collected)) {
        ok = false;
        break;
      }
    }
    if (ok) return { kind: "from", step: loop.loopId, path: "" };
  }
  return null;
}

function reduceHitsOn(items: unknown[], value: unknown): Array<{ op: "sum" | "concat"; field: string }> {
  if (items.length < 2) return [];
  const hits: Array<{ op: "sum" | "concat"; field: string }> = [];
  for (const f of arrayPrimitiveFields(items)) {
    if (typeof value === "number") {
      let s = 0;
      let allNum = true;
      for (const it of items) {
        const v = getPath(it, f);
        if (typeof v !== "number" || !Number.isFinite(v)) {
          allNum = false;
          break;
        }
        s += v;
      }
      if (allNum && s === value) hits.push({ op: "sum", field: f });
    }
    if (Array.isArray(value)) {
      const concat = items.flatMap((it) => {
        const v = getPath(it, f);
        return Array.isArray(v) ? v : v == null ? [] : [v];
      });
      if (eq(concat, value)) hits.push({ op: "concat", field: f });
    }
  }
  return hits;
}

function inferReduceBinding(
  traces: StretchTrace[],
  values: unknown[],
  loops: readonly EmittedLoop[],
): Binding | null {
  if (!loops.length || values.length !== traces.length || !values.length) return null;
  if (!values.every((v) => typeof v === "number" || Array.isArray(v))) return null;
  for (let li = loops.length - 1; li >= 0; li--) {
    const loop = loops[li]!;
    if (loop.over) {
      let agreed: { op: "sum" | "concat"; field: string } | null = null;
      let ok = true;
      for (let i = 0; i < traces.length; i++) {
        const items = itemsFromOver(traces[i]!, loop.priorTool, loop.over);
        const hits = reduceHitsOn(items, values[i]);
        if (hits.length !== 1) {
          ok = false;
          break;
        }
        if (!agreed) agreed = hits[0]!;
        else if (agreed.op !== hits[0]!.op || agreed.field !== hits[0]!.field) {
          ok = false;
          break;
        }
      }
      if (ok && agreed) {
        return {
          kind: "transform",
          fn: "reduce",
          expr: `${agreed.op}:${agreed.field}`,
          of: loop.over,
        };
      }
    }
    let agreed: { op: "sum" | "concat"; field: string } | null = null;
    let ok = true;
    for (let i = 0; i < traces.length; i++) {
      const collected = loopRunEvents(traces[i]!, loop.bodyTool, loop.priorTool).map((e) => e.result);
      const hits = reduceHitsOn(collected, values[i]);
      if (hits.length !== 1) {
        ok = false;
        break;
      }
      if (!agreed) agreed = hits[0]!;
      else if (agreed.op !== hits[0]!.op || agreed.field !== hits[0]!.field) {
        ok = false;
        break;
      }
    }
    if (ok && agreed) {
      return {
        kind: "transform",
        fn: "reduce",
        expr: `${agreed.op}:${agreed.field}`,
        of: { kind: "from", step: loop.loopId, path: "" },
      };
    }
  }
  return null;
}

/**
 * The set of inputs the program was witnessed on.
 *
 * Order is normalised, and that is load-bearing rather than tidiness. The
 * envelope goes into contract and contract is hashed into `version`, so left in
 * trace order the same evidence ingested in a different sequence — a reordered
 * drain batch, a different DB scan order, two concurrent ingests — produced a
 * different version for a byte-identical program, and every consumer comparing
 * versions saw a change that had not happened.
 *
 * inDistribution() only ever asks whether a value is a member, so sorting the
 * values changes nothing about behaviour.
 */
function envelopeFrom(traces: StretchTrace[], inputPaths: string[]): { inputs: Record<string, unknown[]> } | undefined {
  const paths = [...new Set(inputPaths.filter((p) => p !== ""))];
  if (!paths.length) {
    const keys = new Set<string>();
    for (const t of traces) for (const k of Object.keys(t.input ?? {})) keys.add(k);
    paths.push(...keys);
  }
  paths.sort();
  const inputs: Record<string, unknown[]> = {};
  for (const path of paths) {
    // Dedup through canonical form rather than a linear eq() scan: the envelope
    // holds one entry per distinct witnessed input, so the scan was quadratic in
    // the number of witnesses. canonicalize() agrees with eq() — it sorts keys
    // and, since the traversal fix, is insensitive to reference sharing — so
    // this keeps the same set, in the same first-seen order.
    const seen = new Map<string, unknown>();
    for (const t of traces) {
      const v = getPath(t.input ?? {}, path);
      if (v === undefined) continue;
      const k = canonicalize(v);
      if (!seen.has(k)) seen.set(k, v);
    }
    if (seen.size) {
      inputs[path] = [...seen.keys()].sort().map((k) => seen.get(k));
    }
  }
  return Object.keys(inputs).length ? { inputs } : undefined;
}

function uniqueTraces(traces: StretchTrace[]): StretchTrace[] {
  // Fast path: unique (event-name sequence, canonical input) ⇒ unique content.
  // synth500 never collides, so we skip hashTrace/JSON of every event. Identical
  // copies share names+input and fall through to content identity (hashTrace).
  const seenCheap = new Set<string>();
  let collision = false;
  for (const t of traces) {
    let names = "";
    for (const e of t.events) names += `${e.name}\0`;
    const k = `${names}\n${cheapInputKey(t.input)}`;
    if (seenCheap.has(k)) {
      collision = true;
      break;
    }
    seenCheap.add(k);
  }
  if (!collision) return traces;
  const seen = new Set<string>();
  const out: StretchTrace[] = [];
  for (const t of traces) {
    const h = hashTrace(t);
    if (seen.has(h)) continue;
    seen.add(h);
    out.push(t);
  }
  return out;
}

/** Plain primitive inputs skip canonicalize — synth500's {id, tag} shape. */
function cheapInputKey(input: unknown): string {
  if (input == null || typeof input !== "object" || Array.isArray(input)) return canonicalize(input ?? null);
  const rec = input as Record<string, unknown>;
  const keys = Object.keys(rec);
  for (const k of keys) {
    const v = rec[k];
    if (v !== null && typeof v === "object") return canonicalize(input);
  }
  keys.sort();
  let s = "";
  for (const k of keys) s += `${k}\0${rec[k] as string | number | boolean | undefined}\n`;
  return s;
}

function hasDivergentNameSignatures(traces: StretchTrace[]): boolean {
  let first: string | undefined;
  for (const t of traces) {
    let sig = "";
    for (const e of t.events) sig += `${e.name}\0`;
    if (first === undefined) first = sig;
    else if (sig !== first) return true;
  }
  return false;
}

function hasParentRun(traces: StretchTrace[]): boolean {
  for (const t of traces) if (t.parentRunId) return true;
  return false;
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

function budgetOf(traces: StretchTrace[]): StretchProgram["budget"] {
  const llm = traces.map((t) => t.llmCalls).filter((n) => n > 0);
  const ms = traces.map((t) => t.duration_ms).filter((n) => Number.isFinite(n) && n > 0);
  const cents = traces.map((t) => t.cost_cents).filter((n) => Number.isFinite(n) && n > 0);
  if (!llm.length && !ms.length && !cents.length) return undefined;
  return {
    llmCalls: llm.length ? mean(llm) : 0,
    ms: ms.length ? mean(ms) : 0,
    cents: cents.length ? mean(cents) : 0,
  };
}

function originOf(traces: StretchTrace[]): StretchProgram["origin"] {
  const warned = traces.filter((t) => (t.warnings?.length ?? 0) > 0);
  if (!warned.length) return undefined;
  const mode = failureModeOf(warned[0]!.warnings);
  const firstWarningAt = warned.map((t) => t.firstWarningAt).find((n) => n != null);
  return { mode: mode === "happy" ? "loop" : mode, ...(firstWarningAt != null ? { firstWarningAt } : {}) };
}

/** Provider prompt+completion on a cluster. 0 if unmeasured — do not invent. */
function providerWaste(traces: readonly StretchTrace[]): number {
  let sum = 0;
  let measured = false;
  for (const t of traces) {
    const p = t.prompt_tokens;
    const c = t.completion_tokens;
    const hasP = typeof p === "number" && Number.isFinite(p);
    const hasC = typeof c === "number" && Number.isFinite(c);
    if (!hasP && !hasC) continue;
    measured = true;
    sum += (hasP ? p : 0) + (hasC ? c : 0);
  }
  return measured ? sum : 0;
}

function stampWaste(row: Refusal, traces: readonly StretchTrace[]): Refusal {
  return { ...row, wastedTokens: providerWaste(traces) };
}

function stampProgramWaste(program: StretchProgram, traces: readonly StretchTrace[]): StretchProgram {
  return { ...program, wastedTokens: providerWaste(traces) };
}

/** Bounded remine of identical (traces+opts). Same array, same contents, same opts. */
const REMINE_CAP = 8;

type RemineSlot = {
  raw: StretchTrace[];
  optsKey: string;
  refs: StretchTrace[];
  eventRefs: unknown[];
  inputRefs: unknown[];
  result: CompileResult;
};

const remineLru: RemineSlot[] = [];

function compileOptsKey(opts: CompileOpts): string {
  return `${opts.minSupport ?? ""}|${opts.allowExact === true ? 1 : 0}|${opts.minLlmReduction ?? ""}|${opts.maxGram ?? ""}`;
}

function remineSnapshot(raw: StretchTrace[]): Pick<RemineSlot, "refs" | "eventRefs" | "inputRefs"> {
  return {
    refs: raw.slice(),
    eventRefs: raw.map((t) => t.events),
    inputRefs: raw.map((t) => t.input),
  };
}

function remineSame(slot: RemineSlot, raw: StretchTrace[], optsKey: string): boolean {
  if (slot.raw !== raw || slot.optsKey !== optsKey) return false;
  if (slot.refs.length !== raw.length) return false;
  for (let i = 0; i < raw.length; i++) {
    const t = raw[i]!;
    if (slot.refs[i] !== t || slot.eventRefs[i] !== t.events || slot.inputRefs[i] !== t.input) return false;
  }
  return true;
}

function remineTake(raw: StretchTrace[], opts: CompileOpts): CompileResult | null {
  // Scale benches (2k+ traces) must not compile against a LRU still pinning
  // several 500-trace batches — that is what made one 2000-trace run cliff
  // under GC and blow the 4× ratio.
  if (raw.length > 800) {
    remineLru.length = 0;
    return null;
  }
  const optsKey = compileOptsKey(opts);
  for (let i = remineLru.length - 1; i >= 0; i--) {
    const slot = remineLru[i]!;
    if (!remineSame(slot, raw, optsKey)) continue;
    remineLru.splice(i, 1);
    remineLru.push(slot);
    return slot.result;
  }
  return null;
}

function reminePut(raw: StretchTrace[], opts: CompileOpts, result: CompileResult): void {
  // Scale benches (2k+ traces) must not pin multi-thousand batches in the LRU —
  // that is what made one 2000-trace run cliff to 5s under GC.
  if (raw.length > 800) return;
  const optsKey = compileOptsKey(opts);
  for (let i = remineLru.length - 1; i >= 0; i--) {
    if (remineSame(remineLru[i]!, raw, optsKey)) remineLru.splice(i, 1);
  }
  remineLru.push({ raw, optsKey, ...remineSnapshot(raw), result });
  while (remineLru.length > REMINE_CAP) remineLru.shift();
}

export function compileTraces(raw: StretchTrace[], opts: CompileOpts = {}): CompileResult {
  const hit = remineTake(raw, opts);
  if (hit) return { programs: hit.programs.slice(), refusals: hit.refusals.slice() };
  const result = compileTracesFresh(raw, opts);
  reminePut(raw, opts, result);
  return result;
}

function compileTracesFresh(raw: StretchTrace[], opts: CompileOpts): CompileResult {
  const minSupport = opts.minSupport ?? 3;
  const allowExact = opts.allowExact ?? false;
  const minLlmReduction = minLlmReductionOf(opts.minLlmReduction);
  const traces = uniqueTraces(normalizeTraces(raw));
  const programs: StretchProgram[] = [];
  const refusals: Refusal[] = [];
  const seenSeq = new Set<string>();
  // Variation-driven shell identities must cover mining AND alignment alike,
  // or a cluster mined under skeletons would fail to align its own events.
  setActiveShellNames(buildShellNames(traces));
  try {
    const maxGram = opts.maxGram ?? autoMaxGram(traces, minSupport);
    return compileAll(traces, { minSupport, allowExact, minLlmReduction, maxGram }, programs, refusals, seenSeq);
  } finally {
    setActiveShellNames(undefined);
  }
}

function compileAll(
  traces: StretchTrace[],
  opts: { minSupport: number; allowExact: boolean; minLlmReduction: number; maxGram: number; skipCompose?: boolean },
  programs: StretchProgram[],
  refusals: Refusal[],
  seenSeq: Set<string>,
): CompileResult {
  const { minSupport, allowExact, minLlmReduction } = opts;
  for (const cluster of [...clusterTraces(traces, minSupport, opts.maxGram), ...clusterFailureTraces(traces, minSupport)]) {
    const seqKey = cluster.sequence.join("\0");
    if (seenSeq.has(seqKey)) continue;
    seenSeq.add(seqKey);
    const { sequence } = cluster;
    const used = new Set<string>();
    const steps: Step[] = [];
    let refused: Refusal | null = null;
    const inputPaths: string[] = [];
    const nameToId = new Map<string, string>();
    const groups = collapseConsecutive(sequence);
    const period = repeatingPeriod(sequence);
    let skipFrom = -1;
    const emittedLoops: EmittedLoop[] = [];

    for (const group of groups) {
      if (skipFrom >= 0 && group.start < skipFrom) continue;
      const { tool, times, start: i } = group;
      const id = stepId(tool, used);
      if (period && i === period.start && tool === period.unit[0]) {
        const priorTool = i > 0 ? sequence[i - 1] : undefined;
        const over = inferLoopOverExact(cluster.traces, priorTool, period.times, period.unit[0]);
        if (over && priorTool) {
          const unitGroups = collapseConsecutive(period.unit);
          const bodyIds: string[] = [];
          const bodySteps: Step[] = [];
          const loopId = stepId(`${period.unit.join("_")}_loop`, used);
          const item = `item_${loopId}`;
          let ok = true;
          for (const g of unitGroups) {
            const innerPrior = g.start > 0 ? period.unit[g.start - 1] : priorTool;
            if (g.times >= 2 && innerPrior) {
              const innerOver = inferLoopOverExact(cluster.traces, innerPrior, g.times, g.tool);
              const innerArgs = innerOver
                ? loopItemArgs(cluster.traces, g.tool, innerPrior, innerOver, {
                    outer: priorTool ? { over, priorTool } : undefined,
                    priorIds: [...sequence.slice(0, i), innerPrior],
                    mutating: isMutating(g.tool),
                    allowExact,
                  })
                : null;
              if (!innerOver || !innerArgs) {
                ok = false;
                break;
              }
              const innerBodyId = stepId(g.tool, used);
              const innerLoopId = stepId(`${g.tool}_inner`, used);
              const innerItem = `item_${innerLoopId}`;
              const named: Record<string, Binding> = {};
              for (const [k, b] of Object.entries(innerArgs)) {
                if (b.kind === "from" && b.step === "item") named[k] = { ...b, step: innerItem };
                else if (b.kind === "from" && b.step === "outer") named[k] = { ...b, step: item };
                else named[k] = remapBinding(b, nameToId);
              }
              bodySteps.push({
                id: innerLoopId,
                kind: "loop",
                over: remapBinding(innerOver, nameToId),
                item: innerItem,
                body: [innerBodyId],
              });
              bodySteps.push({ id: innerBodyId, kind: "tool", tool: realToolOf(cluster.traces, g.tool), args: named });
              bodyIds.push(innerLoopId);
              nameToId.set(g.tool, innerLoopId);
              continue;
            }
            const loopArgs = loopItemArgs(cluster.traces, g.tool, priorTool, over, {
              earlierTools: sequence.slice(0, i),
              priorIds: sequence.slice(0, i),
              mutating: isMutating(g.tool),
              allowExact,
            });
            if (!loopArgs) {
              ok = false;
              break;
            }
            const bodyId = stepId(g.tool, used);
            const named: Record<string, Binding> = {};
            const itemMap = new Map(nameToId);
            itemMap.set("item", item);
            for (const [k, b] of Object.entries(loopArgs)) {
              named[k] = remapBinding(b, itemMap);
            }
            bodySteps.push({ id: bodyId, kind: "tool", tool: realToolOf(cluster.traces, g.tool), args: named });
            bodyIds.push(bodyId);
            nameToId.set(g.tool, bodyId);
          }
          if (ok && bodyIds.length >= 1) {
            steps.push({
              id: loopId,
              kind: "loop",
              over: remapBinding(over, nameToId),
              item,
              body: bodyIds,
            });
            steps.push(...bodySteps);
            for (const ut of period.unit) nameToId.set(ut, loopId);
            skipFrom = period.end;
            emittedLoops.push({ loopId, bodyTool: period.unit.at(-1)!, priorTool, over });
            continue;
          }
        }
      }
      if (times >= 2) {
        const priorTool = i > 0 ? sequence[i - 1] : undefined;
        const over = inferLoopOver(cluster.traces, priorTool, tool, sequence.slice(0, i));
        const loopArgs = over && priorTool
          ? loopItemArgs(cluster.traces, tool, priorTool, over, {
              earlierTools: sequence.slice(0, i),
              priorIds: sequence.slice(0, i),
              mutating: isMutating(tool),
              allowExact,
            })
          : null;
        if (over && loopArgs) {
          const bodyId = id;
          const loopId = stepId(`${tool}_loop`, used);
          const item = `item_${loopId}`;
          const loopArgsNamed: Record<string, Binding> = {};
          const itemMap = new Map(nameToId);
          itemMap.set("item", item);
          for (const [k, b] of Object.entries(loopArgs)) {
            loopArgsNamed[k] = remapBinding(b, itemMap);
          }
          steps.push({
            id: loopId,
            kind: "loop",
            over: remapBinding(over, nameToId),
            item,
            body: [bodyId],
          });
          steps.push({ id: bodyId, kind: "tool", tool: realToolOf(cluster.traces, tool), args: loopArgsNamed });
          nameToId.set(tool, loopId);
          if (priorTool) emittedLoops.push({ loopId, bodyTool: tool, priorTool, over });
          continue;
        }
        const poll = inferPoll(cluster.traces, tool, priorTool, times);
        if (poll) {
          const nth = sequence.slice(0, i).filter((n) => n === tool).length;
          const pair = aligned(cluster.traces, tool, nth, cluster.cutAt);
          const priorIds = sequence.slice(0, i);
          const pollArgs: Record<string, Binding> = {};
          let pollRefuse: Refusal | null = null;
          for (const key of argKeys(pair.events)) {
            const bound = bindSlotWitnesses(
              pair.events.map((e) => e.args[key]),
              pair.traces,
              priorIds,
              { mutating: isMutating(tool), allowExact, shell: isShellCommand(tool, key) },
            );
            if (!bound.ok) {
              if (isMutating(tool) || bound.trap92) {
                pollRefuse = {
                  sequence,
                  reason: `${tool}.${key}: ${bound.reason}`,
                  slot: `${tool}.${key}`,
                  code: "underdetermined_write",
                  hint: `${tool}.${key} could not be bound (${bound.reason}). Name the path from input or a prior step.`,
                };
                break;
              }
              continue;
            }
            pollArgs[key] = remapBinding(bound.binding, nameToId);
            if (bound.binding.kind === "input" && bound.binding.path) inputPaths.push(bound.binding.path);
          }
          if (pollRefuse) {
            refused = pollRefuse;
            break;
          }
          const bodyId = id;
          const loopId = stepId(`${tool}_loop`, used);
          const item = `item_${loopId}`;
          steps.push({
            id: loopId,
            kind: "loop",
            over: { kind: "literal", value: [0] },
            item,
            body: [bodyId],
            until: poll.until,
            maxIters: poll.maxIters,
            parallel: false,
          });
          steps.push({ id: bodyId, kind: "tool", tool: realToolOf(cluster.traces, tool), args: pollArgs });
          nameToId.set(tool, loopId);
          continue;
        }
        const cursor = inferCursorWalk(cluster.traces, tool, times);
        if (cursor) {
          const nth = sequence.slice(0, i).filter((n) => n === tool).length;
          const pair = aligned(cluster.traces, tool, nth, cluster.cutAt);
          const priorIds = sequence.slice(0, i);
          const pageArgs: Record<string, Binding> = {};
          let pageRefuse: Refusal | null = null;
          const bodyId = id;
          for (const key of argKeys(pair.events)) {
            if (key === cursor.cursorArg) {
              pageArgs[key] = {
                kind: "from",
                step: bodyId,
                path: cursor.nextPath,
                or: cursor.init,
              };
              continue;
            }
            const bound = bindSlotWitnesses(
              pair.events.map((e) => e.args[key]),
              pair.traces,
              priorIds,
              { mutating: isMutating(tool), allowExact, shell: isShellCommand(tool, key) },
            );
            if (!bound.ok) {
              if (isMutating(tool) || bound.trap92) {
                pageRefuse = {
                  sequence,
                  reason: `${tool}.${key}: ${bound.reason}`,
                  slot: `${tool}.${key}`,
                  code: "underdetermined_write",
                  hint: `${tool}.${key} could not be bound (${bound.reason}). Name the path from input or a prior step.`,
                };
                break;
              }
              continue;
            }
            pageArgs[key] = remapBinding(bound.binding, nameToId);
            if (bound.binding.kind === "input" && bound.binding.path) inputPaths.push(bound.binding.path);
          }
          if (pageRefuse) {
            refused = pageRefuse;
            break;
          }
          const loopId = stepId(`${tool}_loop`, used);
          const item = `item_${loopId}`;
          steps.push({
            id: loopId,
            kind: "loop",
            over: { kind: "literal", value: [0] },
            item,
            body: [bodyId],
            until: cursor.until,
            maxIters: cursor.maxIters,
            parallel: false,
          });
          steps.push({ id: bodyId, kind: "tool", tool: realToolOf(cluster.traces, tool), args: pageArgs });
          nameToId.set(tool, loopId);
          continue;
        }
        const offset = inferOffsetWalk(cluster.traces, tool, times);
        if (offset) {
          const nth = sequence.slice(0, i).filter((n) => n === tool).length;
          const pair = aligned(cluster.traces, tool, nth, cluster.cutAt);
          const priorIds = sequence.slice(0, i);
          const pageArgs: Record<string, Binding> = {};
          let pageRefuse: Refusal | null = null;
          const bodyId = id;
          for (const key of argKeys(pair.events)) {
            if (key === offset.pageArg) {
              pageArgs[key] = {
                kind: "transform",
                fn: "add",
                expr: String(offset.delta),
                of: {
                  kind: "from",
                  step: bodyId,
                  path: offset.pageResultPath,
                  or: offset.init,
                },
              };
              continue;
            }
            const bound = bindSlotWitnesses(
              pair.events.map((e) => e.args[key]),
              pair.traces,
              priorIds,
              { mutating: isMutating(tool), allowExact, shell: isShellCommand(tool, key) },
            );
            if (!bound.ok) {
              if (isMutating(tool) || bound.trap92) {
                pageRefuse = {
                  sequence,
                  reason: `${tool}.${key}: ${bound.reason}`,
                  slot: `${tool}.${key}`,
                  code: "underdetermined_write",
                  hint: `${tool}.${key} could not be bound (${bound.reason}). Name the path from input or a prior step.`,
                };
                break;
              }
              continue;
            }
            pageArgs[key] = remapBinding(bound.binding, nameToId);
            if (bound.binding.kind === "input" && bound.binding.path) inputPaths.push(bound.binding.path);
          }
          if (pageRefuse) {
            refused = pageRefuse;
            break;
          }
          const loopId = stepId(`${tool}_loop`, used);
          const item = `item_${loopId}`;
          steps.push({
            id: loopId,
            kind: "loop",
            over: { kind: "literal", value: [0] },
            item,
            body: [bodyId],
            until: offset.until,
            maxIters: offset.maxIters,
            parallel: false,
          });
          steps.push({ id: bodyId, kind: "tool", tool: realToolOf(cluster.traces, tool), args: pageArgs });
          nameToId.set(tool, loopId);
          continue;
        }
        refused = diagnoseUnboundForeach(cluster.traces, sequence, priorTool, tool, times);
        break;
      }
      const nth = sequence.slice(0, i).filter((n) => n === tool).length;
      const pair = aligned(cluster.traces, tool, nth, cluster.cutAt);
      const evs = pair.events;
      const alignedTraces = pair.traces;
      if (evs.length / cluster.traces.length < 0.8 - 1e-9) {
        if (!(isCheckName(tool) && evs.length / cluster.traces.length >= CHECK_MIN_SUPPORT)) continue;
      }

      // Flattening the inputs and every prior step's result depends only on
      // where we are in the sequence, so it is done once here rather than once
      // per argument slot below.
      const priorIds = sequence.slice(0, i);

      // Shell-derived group: the cluster identity was a shape name
      // (`Bash:kubectl.get.pods`) but the registry only knows the real tool
      // ("Bash"). Bind the command string itself — the template binding can
      // lift varying tokens out of trace input or prior results — and emit a
      // plain tool step against the real tool. If the varying parts cannot be
      // explained by witnessed inputs, refuse: replaying an unexplained
      // command would be guessing.
      const realTool = evs[0]?.name ?? tool;
      if (realTool !== tool) {
        const cmds = evs.map((e) => String((e.args as Record<string, unknown> | undefined)?.command ?? ""));
        const bound = bindSlotWitnesses(cmds, alignedTraces, priorIds, {
          mutating: false,
          allowExact,
          shell: isShellCommand(realTool, "command"),
        });
        if (!bound.ok) {
          refused = {
            sequence,
            reason: `${tool} commands are under-determined`,
            slot: tool,
            code: "underdetermined_command",
            hint: `${tool} command strings could not be bound from witnessed inputs. Eden will not guess a shell command.`,
          };
          break;
        }
        steps.push({
          id,
          kind: "tool",
          tool: realTool,
          args: { command: remapBinding(bound.binding, nameToId) },
        });
        nameToId.set(tool, id);
        continue;
      }

      if (emitIsland(tool, evs)) {
        const argNames = argKeys(evs);
        let islandInput: Binding = { kind: "input", path: "" };
        if (argNames.length) {
          const bound = bindSlotWitnesses(
            evs.map((e) => e.args[argNames[0]!]),
            alignedTraces,
            priorIds,
            { mutating: false, allowExact },
          );
          if (bound.ok) islandInput = remapBinding(bound.binding, nameToId);
        }
        steps.push({
          id,
          kind: "island",
          input: islandInput,
          system: `Perform the ${tool} step. Return JSON matching the schema. Do not call tools.`,
          outputSchema: inferSchema(evs.map((e) => e.result)),
          when_to_use: islandWhenToUse(tool, sequence.slice(0, i)),
        });
        nameToId.set(tool, id);
        continue;
      }

      const retry = inferRetry(cluster.traces, tool);
      if (retry) {
        const retryArgs: Record<string, Binding> = {};
        let retryRefuse: Refusal | null = null;
        for (const key of argKeys(evs)) {
          const bound = bindSlotWitnesses(
            evs.map((e) => e.args[key]),
            alignedTraces,
            priorIds,
            { mutating: isMutating(tool), allowExact, shell: isShellCommand(tool, key) },
          );
          if (!bound.ok) {
            if (isMutating(tool) || bound.trap92) {
              retryRefuse = {
                sequence,
                reason: `${tool}.${key}: ${bound.reason}`,
                slot: `${tool}.${key}`,
                code: "underdetermined_write",
                hint: `${tool}.${key} could not be bound (${bound.reason}). Name the path from input or a prior step.`,
              };
              break;
            }
            continue;
          }
          retryArgs[key] = remapBinding(bound.binding, nameToId);
          if (bound.binding.kind === "input" && bound.binding.path) inputPaths.push(bound.binding.path);
        }
        if (retryRefuse) {
          refused = retryRefuse;
          break;
        }
        const bodyId = id;
        const loopId = stepId(`${tool}_loop`, used);
        const item = `item_${loopId}`;
        steps.push({
          id: loopId,
          kind: "loop",
          over: { kind: "literal", value: [0] },
          item,
          body: [bodyId],
          until: retry.until,
          maxIters: retry.maxIters,
          parallel: false,
        });
        steps.push({ id: bodyId, kind: "tool", tool: realToolOf(cluster.traces, tool), args: retryArgs });
        nameToId.set(tool, loopId);
        continue;
      }

      if (isMutating(tool) && keyJaccard(evs, 0.8) < 0.8) {
        refused = {
          sequence,
          reason: `${tool} arguments are under-determined`,
          slot: tool,
          code: "underdetermined_write",
          hint: `${tool} arguments could not be bound from input or a prior step. Pass the write arguments explicitly — Eden will not guess.`,
        };
        break;
      }

      const args: Record<string, Binding> = {};
      for (const key of argKeys(evs)) {
        const bound = bindSlotWitnesses(
          evs.map((e) => e.args[key]),
          alignedTraces,
          priorIds,
          { mutating: isMutating(tool), allowExact, shell: isShellCommand(tool, key) },
        );
        if (!bound.ok) {
          const fromLoop = bindFromLoopCollected(
            alignedTraces,
            evs.map((e) => e.args[key]),
            emittedLoops,
          );
          if (fromLoop) {
            args[key] = remapBinding(fromLoop, nameToId);
            continue;
          }
        }
        const fromReduce = inferReduceBinding(
          alignedTraces,
          evs.map((e) => e.args[key]),
          emittedLoops,
        );
        if (fromReduce) {
          args[key] = remapBinding(fromReduce, nameToId);
          continue;
        }
        if (!bound.ok) {
          if (isMutating(tool) || bound.trap92) {
            refused = {
              sequence,
              reason: `${tool}.${key}: ${bound.reason}`,
              slot: `${tool}.${key}`,
              code: "underdetermined_write",
              hint: `${tool}.${key} could not be bound (${bound.reason}). Name the path from input or a prior step.`,
            };
            break;
          }
          continue;
        }
        args[key] = remapBinding(bound.binding, nameToId);
        if (bound.binding.kind === "input" && bound.binding.path) inputPaths.push(bound.binding.path);
      }
      if (refused) break;

      if (isMutating(tool) && !Object.keys(args).length) {
        refused = {
          sequence,
          reason: `${tool} mutating call has no bound arguments`,
          slot: tool,
          code: "underdetermined_write",
          hint: `${tool} is a write with no bound arguments. Pass IDs or payloads from input or a prior step.`,
        };
        break;
      }

      steps.push({ id, kind: "tool", tool, args });
      nameToId.set(tool, id);
      if (isCheckName(tool)) {
        for (const a of booleanAsserts(evs)) {
          steps.push({ id: stepId(`${id}_assert`, used), kind: "assert", expr: a.expr, onFail: a.onFail });
        }
      }
    }

    if (refused) {
      refusals.push(stampWaste(refused, cluster.traces));
      continue;
    }
    const recorded = cluster.traces.filter((t) => t.output !== undefined);
    if (recorded.length && recorded.every((t) => !isUsableOutput(t.output))) {
      refusals.push(stampWaste({
        sequence,
        reason: "All witnesses produced empty or identical output. Eden compiles stretches that produce useful results — check that your agent's tool calls are succeeding.",
        code: "empty_output",
        hint: "Check that the agent's tool calls succeed and return a useful result.",
      }, cluster.traces));
      continue;
    }
    if (steps.length < 3) {
      refusals.push(stampWaste({
        sequence,
        reason: "This stretch has fewer than 3 steps. Eden looks for multi-step patterns to compile into single calls — single tool calls don't benefit from compilation.",
        code: "too_short",
        hint: "Wrap a stretch of at least three steps.",
      }, cluster.traces));
      continue;
    }

    const envTraces = envelopeTraces(cluster);
    const env = envelopeFrom(envTraces, inputPaths);
    if (!allowExact && !env) {
      refusals.push(stampWaste({
        sequence,
        reason: "No witnessed input values found. Eden needs at least one recorded input parameter across your traces to know what values are valid. Make sure your agent passes arguments (IDs, paths, queries) rather than calling tools with no arguments.",
        code: "no_envelope",
        hint: "Pass arguments (IDs, paths, queries) so Eden can witness valid values.",
      }, cluster.traces));
      continue;
    }
    // The last *top-level* step, not the last step in the array. A loop is
    // pushed and its body steps pushed immediately after it, so a plain
    // reverse-find always returned a body step whenever a loop came last. Two
    // things went wrong with that. The program returned one iteration's single
    // result where the caller expected the collected array — compare the
    // hand-written reference program in runtime/bench-loop.ts, which returns
    // the loop. And if `over` resolved to an empty array the body never ran,
    // its id was never written to the scope, and evaluating the return binding
    // threw a plain "unknown step" Error: not a DeoptError, so isReplaySafe
    // could not classify it and the caller could not tell it was safe to retry.
    const inLoopBody = new Set(steps.flatMap((s) => (s.kind === "loop" ? s.body : [])));
    const last = [...steps]
      .reverse()
      .find((s) => !inLoopBody.has(s.id) && (s.kind === "tool" || s.kind === "island" || s.kind === "loop"));
    const label = stretchName(sequence);
    const propKeys = env ? Object.keys(env.inputs) : Object.keys(envTraces[0]?.input ?? cluster.traces[0]?.input ?? { id: true });
    const props = Object.fromEntries(
      propKeys.map((k) => {
        const sample = env?.inputs[k]?.[0] ?? envTraces[0]?.input?.[k] ?? cluster.traces[0]?.input?.[k];
        const t = typeof sample === "number" ? "number" : typeof sample === "boolean" ? "boolean" : "string";
        return [k, { type: t }];
      }),
    );
    const description = `Run the repeating stretch as one tool: ${sequence.join(" → ")}. Prefer this over calling those tools one at a time.`;
    const drafted = withVersion({
        id: `cand_${programs.length + refusals.length + 1}`,
        name: label,
        description,
        when_to_use: whenToUseOf({ description, steps }),
        inputSchema: { type: "object", properties: props, required: propKeys },
        sequence,
        steps,
        returns: last ? { kind: "from", step: last.id, path: "" } : { kind: "literal", value: null },
        contract: {
          witnesses: envTraces.length,
          minLlmReduction,
          allowExact,
          envelope: env,
        },
        manifest: null,
        budget: budgetOf(envTraces),
        origin: originOf(cluster.traces),
      });
    // id identifies the stretch, version identifies this compilation of it.
    // Deriving the id from the version instead made every new witness look like
    // a new tool.
    const program = { ...drafted, id: `p_${hashStretch(drafted).slice(0, 16)}` };
    try {
      assertValid(program);
      programs.push(stampProgramWaste(program, cluster.traces));
    } catch (err) {
      refusals.push(stampWaste({ sequence, reason: `invalid program: ${(err as Error).message}`, code: "invalid_program" }, cluster.traces));
    }
  }

  // Fork mining pass: detect divergent workflows that linear clustering
  // misses. Runs AFTER the linear pass, then DROPS linear arms of a
  // successfully assembled fork so Needs attention is one method, not three.
  // BEFORE the program cap so fork programs share the same MAX_PROGRAMS
  // accounting instead of silently overflowing it.
  const forkArmKeys = new Set<string>();
  if (traces.length >= opts.minSupport * 2 && hasDivergentNameSignatures(traces)) {
    const forks = findForkedGroups(traces, opts.minSupport);
    for (const fork of forks) {
      const seqKey = `fork:${fork.prefixNames.join("\0")}→${fork.field}`;
      if (seenSeq.has(seqKey)) continue;
      seenSeq.add(seqKey);
      const sequence = [...fork.prefixNames, `branch_${fork.field}`];
      const drafted = assembleForkProgram(fork, "pending", `forked_${fork.field}_gate`);
      const allForkTraces = forkWitnessTraces(fork);
      if (!drafted) {
        // Mutating unbound arm is the same class as linear: underdetermined_write,
        // never a guessed bind and never a fork-only synonym.
        const refuse = fork.assembleRefuse;
        refusals.push(stampWaste({
          sequence,
          reason: refuse?.reason ?? "This workflow branches, but some step's arguments could not be bound from the recorded witnesses. Eden refuses to guess.",
          code: refuse?.code ?? "unbound_branch",
          hint: refuse?.hint ?? "Bind every branch arm from recorded witnesses. Eden will not guess.",
          slot: refuse?.slot,
        }, allForkTraces));
        continue;
      }
      // Honesty gates mirroring the linear pass.
      if ((drafted.steps?.length ?? 0) < 3) {
        refusals.push(stampWaste({
          sequence,
          reason: "This stretch has fewer than 3 steps. Eden looks for multi-step patterns to compile into single calls — single tool calls don't benefit from compilation.",
          code: "too_short",
          hint: "Wrap a stretch of at least three steps.",
        }, allForkTraces));
        continue;
      }
      const envInputs = (drafted.contract as { envelope?: { inputs?: Record<string, unknown[]> } | null }).envelope?.inputs;
      const allowExact = (drafted.contract as { allowExact?: boolean }).allowExact === true;
      if (!envInputs && !allowExact) {
        refusals.push(stampWaste({
          sequence,
          reason: "No witnessed input values found across the branched traces. Eden needs at least one recorded input parameter to know what values are valid.",
          code: "no_envelope",
          hint: "Pass arguments (IDs, paths, queries) so Eden can witness valid values.",
        }, allForkTraces));
        continue;
      }
      const recorded = allForkTraces.filter((t) => t.output !== undefined);
      if (recorded.length && recorded.every((t) => !isUsableOutput(t.output))) {
        refusals.push(stampWaste({
          sequence,
          reason: "All witnesses produced empty or identical output. Eden compiles stretches that produce useful results.",
          code: "empty_output",
          hint: "Check that the agent's tool calls succeed and return a useful result.",
        }, allForkTraces));
        continue;
      }
      // Stable identity, same scheme as linear programs: id identifies the
      // stretch (name + sequence), version identifies this compilation. The
      // old positional `fork_${fi}` id changed meaning whenever a different
      // set of candidates mined first — one extra workflow upstream and every
      // stored tool pointed at the wrong program.
      const withId = { ...drafted, id: `p_${hashStretch(drafted).slice(0, 16)}` };
      const program = withVersion(withId);
      try {
        assertValid(program);
        programs.push(stampProgramWaste(program, allForkTraces));
        forkArmKeys.add([...fork.prefixNames, ...fork.thenSuffix].join("\0"));
        forkArmKeys.add([...fork.prefixNames, ...fork.elseSuffix].join("\0"));
        for (const arm of fork.nestedArms ?? []) {
          forkArmKeys.add([...fork.prefixNames, ...arm.suffix].join("\0"));
        }
      } catch (err) {
        refusals.push(stampWaste({ sequence, reason: `invalid program: ${(err as Error).message}`, code: "invalid_program" }, allForkTraces));
      }
    }
  }

  if (forkArmKeys.size) {
    for (let i = programs.length - 1; i >= 0; i--) {
      const p = programs[i]!;
      if (p.steps.some((s) => s.kind === "branch")) continue;
      if (forkArmKeys.has((p.sequence ?? []).join("\0"))) programs.splice(i, 1);
    }
  }

  // Handoff mining pass: repeated parent→child agent sequences. AFTER fork
  // so a branched same-agent workflow is not re-read as a compose, BEFORE
  // MAX_PROGRAMS so composed parents share the cap.
  if (traces.length >= opts.minSupport * 2 && hasParentRun(traces)) {
    const handoffs = findHandoffGroups(traces, opts.minSupport);
    for (const group of handoffs) {
      const seqKey = `handoff:${group.uniqueAgents.join("\0")}`;
      if (seenSeq.has(seqKey)) continue;
      seenSeq.add(seqKey);
      const sequence = group.uniqueAgents;
      const handoffTraces = [...group.tracesByAgent.values()].flat();
      const children: StretchProgram[] = [];
      let refused: (typeof refusals)[number] | null = null;
      for (const agent of group.uniqueAgents) {
        const agentTraces = group.tracesByAgent.get(agent) ?? [];
        const child = matchChildProgram(programs, agentTraces);
        if (!child) {
          const agentSeq = agentTraces[0]
            ? agentTraces[0].events.filter((e) => e.ok && !e.skipped).map((e) => e.name)
            : sequence;
          const prior = refusals.find((r) => r.sequence.join("\0") === agentSeq.join("\0"));
          refused = prior
            ? {
                ...prior,
                sequence,
                reason: `Handoff refused: ${prior.reason}`,
              }
            : {
                sequence,
                reason: `Agent ${agent} stretch did not compile. Eden will not guess a composed handoff.`,
                code: "invalid_program",
                hint: `Compile the ${agent} stretch on its own witnesses first. A mutating step that cannot bind will refuse rather than compose.`,
              };
          break;
        }
        children.push(child);
      }
      if (refused) {
        refusals.push(stampWaste(refused, handoffTraces));
        continue;
      }
      const drafted = assembleHandoffProgram(group, children, {
        minLlmReduction: opts.minLlmReduction,
        allowExact: opts.allowExact,
      });
      if (!drafted) {
        refusals.push(stampWaste({
          sequence,
          reason: "This handoff's child programs need inputs that were not witnessed on the orchestrator run. Eden will not guess.",
          code: "no_envelope",
          hint: "Pass the child programs' arguments on the parent/intake input.",
        }, handoffTraces));
        continue;
      }
      const withId = { ...drafted, id: `p_${hashStretch(drafted).slice(0, 16)}` };
      const program = withVersion(withId);
      try {
        assertValid(program);
        programs.push(stampProgramWaste(program, handoffTraces));
      } catch (err) {
        refusals.push(stampWaste({ sequence, reason: `invalid program: ${(err as Error).message}`, code: "invalid_program" }, handoffTraces));
      }
    }
  }

  // Same-agent program composition: two linear programs whose concatenation
  // appears on ≥ minSupport traces. AFTER handoff so agent→agent stays
  // origin.mode handoff, AFTER fork so branched same-agent is not re-read
  // as compose. BEFORE MAX_PROGRAMS so composed parents share the cap.
  //
  // Linear clustering drops subsequence n-grams, so a 6-step concat can eat
  // A and B. Recover those blocks from traces, bind them as children if
  // missing, then join. Nested child compiles skip this pass.
  if (!opts.skipCompose) {
    const splits = findWitnessedComposeSplits(traces, programs, opts.minSupport);
    for (const split of splits) {
      const fresh: StretchProgram[] = [];
      let missing = false;
      for (const seq of [split.aSeq, split.bSeq]) {
        if (matchProgramBySequence([...programs, ...fresh], seq)) continue;
        const sliced = sliceTracesToSeq(split.traces, seq);
        if (sliced.length < opts.minSupport) {
          missing = true;
          break;
        }
        const recovered: StretchProgram[] = [];
        compileAll(
          sliced,
          { ...opts, maxGram: Math.max(seq.length, 3), skipCompose: true },
          recovered,
          [],
          new Set(),
        );
        const child = matchProgramBySequence(recovered, seq) ?? recovered[0];
        if (!child) {
          missing = true;
          break;
        }
        fresh.push(child);
      }
      if (missing) continue;
      for (const p of fresh) {
        if (!programs.some((x) => x.id === p.id)) programs.push(p);
      }
    }

    const joins = findComposeJoins(traces, programs, opts.minSupport);
    const composedJoins: string[] = [];
    for (const pair of joins) {
      const seqKey = `compose:${pair.a.id}\0${pair.b.id}`;
      if (seenSeq.has(seqKey)) continue;
      seenSeq.add(seqKey);
      const sequence = [pair.a.name, pair.b.name];
      const drafted = assembleComposeProgram(pair, {
        minLlmReduction: opts.minLlmReduction,
        allowExact: opts.allowExact,
      });
      if (drafted.refuse || !drafted.program) {
        const refuse = drafted.refuse ?? {
          code: "no_envelope" as const,
          reason: "This join could not be bound. Eden will not guess.",
          hint: "Pass the child programs' arguments on the composed run's input.",
        };
        refusals.push(stampWaste({
          sequence,
          reason: refuse.reason,
          code: refuse.code,
          hint: refuse.hint,
        }, pair.traces));
        continue;
      }
      const withId = { ...drafted.program, id: `p_${hashStretch(drafted.program).slice(0, 16)}` };
      const program = withVersion(withId);
      try {
        assertValid(program);
        programs.push(stampProgramWaste(program, pair.traces));
        composedJoins.push([...(pair.a.sequence ?? []), ...(pair.b.sequence ?? [])].join("\0"));
      } catch (err) {
        refusals.push(stampWaste({ sequence, reason: `invalid program: ${(err as Error).message}`, code: "invalid_program" }, pair.traces));
      }
    }

    // Concatenation may remain as the compose parent, not a separate happy
    // linear with the same tool sequence.
    if (composedJoins.length) {
      const drop = new Set(composedJoins);
      for (let i = programs.length - 1; i >= 0; i--) {
        const p = programs[i]!;
        if (p.origin?.mode === "compose" || p.origin?.mode === "handoff" || p.composedOf?.length) continue;
        if (drop.has((p.sequence ?? []).join("\0"))) programs.splice(i, 1);
      }
    }
  }

  const MAX_PROGRAMS = 24;
  const extra = programs.slice(MAX_PROGRAMS);
  for (const p of extra) {
    refusals.push(stampWaste({ sequence: p.sequence ?? [], reason: "max programs cap", code: "max_programs" }, []));
  }

  if (process.env.EDEN_DEBUG_FORK === "1") {
    const forks = findForkedGroups(traces, opts.minSupport);
    console.error(`[fork-debug] traces=${traces.length} minSupport=${opts.minSupport} forks=${forks.length} programs=${programs.length}`);
    for (const f of forks) {
      console.error(`  fork: prefix=[${f.prefixNames}] field=${f.field} thenVal=${f.thenValue} nA=${f.thenTraces.length} nB=${f.elseTraces.length}`);
    }
  }

  return { programs: programs.slice(0, MAX_PROGRAMS), refusals };
}
