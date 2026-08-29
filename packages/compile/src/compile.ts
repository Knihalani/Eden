import type { Refusal, Step, StretchProgram, StretchTrace, TraceEvent, Binding, FromBinding } from "@eden/ir";
import { CHECK_MIN_SUPPORT, assertValid, canonicalize, eq, getPath, hashStretch, hashTrace, withVersion, minLlmReductionOf, failureModeOf, isUsableOutput, whenToUseOf } from "@eden/ir";
import { argKeys, bindContext, bindSlot, inferSchema, isCheckName, isIslandName, isMutating, isReadName, keyJaccard, remapBinding } from "./bind";
import { clusterFailureTraces, clusterTraces, effectiveEventName, buildShellNames, setActiveShellNames, autoMaxGram, envelopeTraces } from "./mine";
import { findForkedGroups, assembleForkProgram } from "./fork";
import { findHandoffGroups, assembleHandoffProgram, matchChildProgram } from "./handoff";
import { findComposeJoins, assembleComposeProgram, findWitnessedComposeSplits, sliceTracesToSeq, matchProgramBySequence } from "./compose";
import { normalizeTraces } from "./normalize";

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

function divergeSameArgs(evs: TraceEvent[]): boolean {
  const seen = new Map<string, string>();
  for (const e of evs) {
    const k = canonicalize(e.args);
    const r = canonicalize(e.result);
    const prev = seen.get(k);
    if (prev && prev !== r) return true;
    seen.set(k, r);
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
    const hits = t.events.filter((ev, j) => (bound === undefined || j < bound) && effectiveEventName(ev) === tool && ev.ok && !ev.skipped);
    const e = hits[nth];
    if (!e) continue;
    tracesOut.push(t);
    events.push(e);
  }
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
  const p = names.indexOf(priorTool);
  if (p < 0 || names[p + 1] !== tool) return 0;
  let n = 0;
  while (names[p + 1 + n] === tool) n++;
  return n;
}

/** Path to the array on `priorTool`'s result whose length is exactly `need`. */
function collectResultArrays(result: unknown): Array<{ path: string; arr: unknown[] }> {
  if (Array.isArray(result)) return [{ path: "", arr: result }];
  if (result && typeof result === "object") {
    const out: Array<{ path: string; arr: unknown[] }> = [];
    for (const [k, v] of Object.entries(result as Record<string, unknown>)) {
      if (Array.isArray(v)) out.push({ path: k, arr: v });
    }
    return out;
  }
  return [];
}

function itemsMatchLoop(arr: unknown[], loopEvs: TraceEvent[]): boolean {
  const n = Math.min(arr.length, loopEvs.length);
  if (n < 2) return false;
  for (let i = 0; i < n; i++) {
    const item = arr[i];
    const args = loopEvs[i]!.args ?? {};
    const hit = Object.values(args).some(
      (v) => eq(v, item) || (item != null && typeof item === "object" && eq(v, (item as Record<string, unknown>).id)),
    );
    if (!hit) return false;
  }
  return true;
}

function loopRunEvents(t: StretchTrace, tool: string, priorTool: string): TraceEvent[] {
  const okEvs = t.events.filter((e) => e.ok && !e.skipped);
  const p = okEvs.findIndex((e) => effectiveEventName(e) === priorTool);
  if (p < 0) return [];
  const run: TraceEvent[] = [];
  for (let i = p + 1; i < okEvs.length && effectiveEventName(okEvs[i]!) === tool; i++) run.push(okEvs[i]!);
  return run;
}

type ArrayBind = { path: string } | { miss: { path: string; readSet: number; repeats: number } };

/**
 * Exact-width bind, with an item-aligned near-miss: if the loop args match a
 * prefix of a longer array (grepCode returned 12, agent read 6), refuse that
 * bind rather than attaching a coincidental same-length sibling array.
 */
function findArrayBinding(t: StretchTrace, priorTool: string, need: number, loopEvs?: TraceEvent[]): ArrayBind | null {
  const prior = t.events.find((e) => effectiveEventName(e) === priorTool && e.ok);
  const arrays = collectResultArrays(prior?.result);
  if (loopEvs && loopEvs.length >= 2) {
    for (const { path, arr } of arrays) {
      if (!itemsMatchLoop(arr, loopEvs)) continue;
      if (arr.length === need) return { path };
      return { miss: { path, readSet: arr.length, repeats: need } };
    }
  }
  for (const { path, arr } of arrays) {
    if (arr.length === need) return { path };
  }
  return null;
}

function inferLoopOver(
  traces: StretchTrace[],
  priorTool: string | undefined,
  tool: string,
): FromBinding | null {
  if (!priorTool || traces.length === 0) return null;
  const paths: string[] = [];
  for (const t of traces) {
    const need = traceRepeatRun(t, tool, priorTool);
    if (need < 2) return null;
    const hit = findArrayBinding(t, priorTool, need, loopRunEvents(t, tool, priorTool));
    if (hit == null || "miss" in hit) return null;
    paths.push(hit.path);
  }
  const path = paths[0]!;
  if (!paths.every((p) => p === path)) return null;
  return { kind: "from", step: priorTool, path };
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
): FromBinding | null {
  if (!priorTool || times < 2) return null;
  const paths: string[] = [];
  for (const t of traces) {
    const hit = findArrayBinding(t, priorTool, times);
    if (hit == null || "miss" in hit) return null;
    paths.push(hit.path);
  }
  const path = paths[0]!;
  if (!paths.every((p) => p === path)) return null;
  return { kind: "from", step: priorTool, path };
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

function loopItemArgs(traces: StretchTrace[], tool: string, priorTool: string, path: string): Record<string, Binding> | null {
  const keyHits = new Map<string, "item" | "id">();
  for (const t of traces) {
    const prior = t.events.find((e) => effectiveEventName(e) === priorTool && e.ok);
    const raw = path ? (prior?.result as Record<string, unknown> | undefined)?.[path] : prior?.result;
    const items = Array.isArray(raw) ? raw : [];
    const evsAll = t.events.filter((e) => effectiveEventName(e) === tool && e.ok);
    const evs = items.length && evsAll.length > items.length && evsAll.length % items.length === 0
      ? evsAll.slice(0, items.length)
      : evsAll;
    if (items.length !== evs.length) return null;
    for (let i = 0; i < evs.length; i++) {
      const args = evs[i]!.args ?? {};
      const item = items[i];
      for (const [k, v] of Object.entries(args)) {
        if (eq(v, item)) keyHits.set(k, "item");
        else if (item && typeof item === "object" && eq(v, (item as Record<string, unknown>).id)) {
          keyHits.set(k, "id");
        }
      }
    }
  }
  if (!keyHits.size) return null;
  const args: Record<string, Binding> = {};
  for (const [k, how] of keyHits) {
    args[k] = how === "item" ? { kind: "from", step: "item", path: "" } : { kind: "from", step: "item", path: "id" };
  }
  return args;
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

export function compileTraces(raw: StretchTrace[], opts: CompileOpts = {}): CompileResult {
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

    for (const group of groups) {
      if (skipFrom >= 0 && group.start < skipFrom) continue;
      const { tool, times, start: i } = group;
      const id = stepId(tool, used);
      if (period && i === period.start && tool === period.unit[0]) {
        const priorTool = i > 0 ? sequence[i - 1] : undefined;
        const over = inferLoopOverExact(cluster.traces, priorTool, period.times);
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
              const innerOver = inferLoopOverExact(cluster.traces, innerPrior, g.times);
              const innerArgs = innerOver ? loopItemArgs(cluster.traces, g.tool, innerPrior, innerOver.path) : null;
              if (!innerOver || !innerArgs) {
                ok = false;
                break;
              }
              const innerBodyId = stepId(g.tool, used);
              const innerLoopId = stepId(`${g.tool}_inner`, used);
              const innerItem = `item_${innerLoopId}`;
              const named: Record<string, Binding> = {};
              for (const [k, b] of Object.entries(innerArgs)) {
                named[k] = b.kind === "from" && b.step === "item" ? { ...b, step: innerItem } : b;
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
            const loopArgs = loopItemArgs(cluster.traces, g.tool, priorTool, over.path);
            if (!loopArgs) {
              ok = false;
              break;
            }
            const bodyId = stepId(g.tool, used);
            const named: Record<string, Binding> = {};
            for (const [k, b] of Object.entries(loopArgs)) {
              named[k] = b.kind === "from" && b.step === "item" ? { ...b, step: item } : b;
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
            continue;
          }
        }
      }
      if (times >= 2) {
        const priorTool = i > 0 ? sequence[i - 1] : undefined;
        const over = inferLoopOver(cluster.traces, priorTool, tool);
        const loopArgs = over && priorTool ? loopItemArgs(cluster.traces, tool, priorTool, over.path) : null;
        if (over && loopArgs) {
          const bodyId = id;
          const loopId = stepId(`${tool}_loop`, used);
          const item = `item_${loopId}`;
          const loopArgsNamed: Record<string, Binding> = {};
          for (const [k, b] of Object.entries(loopArgs)) {
            loopArgsNamed[k] = b.kind === "from" && b.step === "item" ? { ...b, step: item } : b;
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
      const ctx = bindContext(alignedTraces, sequence.slice(0, i));

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
        const bound = bindSlot(cmds, ctx, { mutating: false, allowExact });
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
          const bound = bindSlot(
            evs.map((e) => e.args[argNames[0]!]),
            ctx,
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
        const bound = bindSlot(
          evs.map((e) => e.args[key]),
          ctx,
          { mutating: isMutating(tool), allowExact },
        );
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
  if (traces.length >= opts.minSupport * 2) {
    const forks = findForkedGroups(traces, opts.minSupport);
    for (const fork of forks) {
      const seqKey = `fork:${fork.prefixNames.join("\0")}→${fork.field}`;
      if (seenSeq.has(seqKey)) continue;
      seenSeq.add(seqKey);
      const sequence = [...fork.prefixNames, `branch_${fork.field}`];
      const drafted = assembleForkProgram(fork, "pending", `forked_${fork.field}_gate`);
      const allForkTraces = [...fork.thenTraces, ...fork.elseTraces];
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
  if (traces.length >= opts.minSupport * 2) {
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
