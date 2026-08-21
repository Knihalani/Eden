import type { Refusal, Step, StretchProgram, StretchTrace, TraceEvent, Binding, FromBinding } from "@eden/ir";
import { CHECK_MIN_SUPPORT, assertValid, canonicalize, eq, getPath, hashStretch, hashTrace, withVersion, minLlmReductionOf, failureModeOf, isUsableOutput } from "@eden/ir";
import { argKeys, bindContext, bindSlot, inferSchema, isCheckName, isIslandName, isMutating, keyJaccard, remapBinding } from "./bind";
import { clusterFailureTraces, clusterTraces } from "./mine";
import { normalizeTraces } from "./normalize";

export type CompileOpts = {
  minSupport?: number;
  allowExact?: boolean;
  minLlmReduction?: number;
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

function aligned(traces: StretchTrace[], tool: string, nth = 0): { traces: StretchTrace[]; events: TraceEvent[] } {
  const tracesOut: StretchTrace[] = [];
  const events: TraceEvent[] = [];
  for (const t of traces) {
    const hits = t.events.filter((ev) => ev.name === tool && ev.ok && !ev.skipped);
    const e = hits[nth];
    if (!e) continue;
    tracesOut.push(t);
    events.push(e);
  }
  return { traces: tracesOut, events };
}

function repeatingPeriod(seq: string[]): { start: number; unit: string[]; times: number; end: number } | null {
  let best: { start: number; unit: string[]; times: number; end: number; score: number } | null = null;
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

function inferLoopOver(
  traces: StretchTrace[],
  priorTool: string | undefined,
  times: number,
): FromBinding | null {
  if (!priorTool || times < 2) return null;
  const paths: string[] = [];
  for (const t of traces) {
    const prior = t.events.find((e) => e.name === priorTool && e.ok);
    const r = prior?.result;
    if (Array.isArray(r) && r.length === times) {
      paths.push("");
      continue;
    }
    if (r && typeof r === "object") {
      const hit = Object.entries(r as Record<string, unknown>).find(([, v]) => Array.isArray(v) && v.length === times);
      if (hit) {
        paths.push(hit[0]);
        continue;
      }
    }
    return null;
  }
  const path = paths[0]!;
  if (!paths.every((p) => p === path)) return null;
  return { kind: "from", step: priorTool, path };
}

function loopItemArgs(traces: StretchTrace[], tool: string, priorTool: string, path: string): Record<string, Binding> | null {
  const keyHits = new Map<string, "item" | "id">();
  for (const t of traces) {
    const prior = t.events.find((e) => e.name === priorTool && e.ok);
    const raw = path ? (prior?.result as Record<string, unknown> | undefined)?.[path] : prior?.result;
    const items = Array.isArray(raw) ? raw : [];
    const evsAll = t.events.filter((e) => e.name === tool && e.ok);
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

export function compileTraces(raw: StretchTrace[], opts: CompileOpts = {}): CompileResult {
  const minSupport = opts.minSupport ?? 3;
  const allowExact = opts.allowExact ?? false;
  const minLlmReduction = minLlmReductionOf(opts.minLlmReduction);
  const traces = uniqueTraces(normalizeTraces(raw));
  const programs: StretchProgram[] = [];
  const refusals: Refusal[] = [];
  const seenSeq = new Set<string>();

  for (const cluster of [...clusterTraces(traces, minSupport), ...clusterFailureTraces(traces, minSupport)]) {
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
        const over = inferLoopOver(cluster.traces, priorTool, period.times);
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
              const innerOver = inferLoopOver(cluster.traces, innerPrior, g.times);
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
              bodySteps.push({ id: innerBodyId, kind: "tool", tool: g.tool, args: named });
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
            bodySteps.push({ id: bodyId, kind: "tool", tool: g.tool, args: named });
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
        const over = inferLoopOver(cluster.traces, priorTool, times);
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
          steps.push({ id: bodyId, kind: "tool", tool, args: loopArgsNamed });
          nameToId.set(tool, loopId);
          continue;
        }
        refused = { sequence, reason: `${tool} repeats ${times}x without a bindable foreach`, slot: tool };
        break;
      }
      const nth = sequence.slice(0, i).filter((n) => n === tool).length;
      const pair = aligned(cluster.traces, tool, nth);
      const evs = pair.events;
      const alignedTraces = pair.traces;
      if (evs.length / cluster.traces.length < 0.8 - 1e-9) {
        if (!(isCheckName(tool) && evs.length / cluster.traces.length >= CHECK_MIN_SUPPORT)) continue;
      }

      // Flattening the inputs and every prior step's result depends only on
      // where we are in the sequence, so it is done once here rather than once
      // per argument slot below.
      const ctx = bindContext(alignedTraces, sequence.slice(0, i));

      if (isIslandName(tool) || (!isMutating(tool) && !isCheckName(tool) && divergeSameArgs(evs))) {
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
        });
        nameToId.set(tool, id);
        continue;
      }

      if (isMutating(tool) && keyJaccard(evs, 0.8) < 0.8) {
        refused = { sequence, reason: `${tool} arguments are under-determined`, slot: tool };
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
            refused = { sequence, reason: `${tool}.${key}: ${bound.reason}`, slot: `${tool}.${key}` };
            break;
          }
          continue;
        }
        args[key] = remapBinding(bound.binding, nameToId);
        if (bound.binding.kind === "input" && bound.binding.path) inputPaths.push(bound.binding.path);
      }
      if (refused) break;

      if (isMutating(tool) && !Object.keys(args).length) {
        refused = { sequence, reason: `${tool} mutating call has no bound arguments`, slot: tool };
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
      refusals.push(refused);
      continue;
    }
    const recorded = cluster.traces.filter((t) => t.output !== undefined);
    if (recorded.length && recorded.every((t) => !isUsableOutput(t.output))) {
      refusals.push({ sequence, reason: "constant/empty output" });
      continue;
    }
    if (steps.length < 3) {
      refusals.push({ sequence, reason: "compiled to fewer than 3 steps" });
      continue;
    }

    const env = envelopeFrom(cluster.traces, inputPaths);
    if (!allowExact && !env) {
      refusals.push({ sequence, reason: "under-determined envelope: no witnessed inputs" });
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
    const propKeys = env ? Object.keys(env.inputs) : Object.keys(cluster.traces[0]?.input ?? { id: true });
    const props = Object.fromEntries(
      propKeys.map((k) => {
        const sample = env?.inputs[k]?.[0] ?? cluster.traces[0]?.input?.[k];
        const t = typeof sample === "number" ? "number" : typeof sample === "boolean" ? "boolean" : "string";
        return [k, { type: t }];
      }),
    );
    const drafted = withVersion({
        id: `cand_${programs.length + refusals.length + 1}`,
        name: label,
        description: `Run the repeating stretch as one tool: ${sequence.join(" → ")}. Prefer this over calling those tools one at a time.`,
        inputSchema: { type: "object", properties: props, required: propKeys },
        sequence,
        steps,
        returns: last ? { kind: "from", step: last.id, path: "" } : { kind: "literal", value: null },
        contract: {
          witnesses: cluster.traces.length,
          minLlmReduction,
          allowExact,
          envelope: env,
        },
        manifest: null,
        budget: budgetOf(cluster.traces),
        origin: originOf(cluster.traces),
      });
    // id identifies the stretch, version identifies this compilation of it.
    // Deriving the id from the version instead made every new witness look like
    // a new tool.
    const program = { ...drafted, id: `p_${hashStretch(drafted).slice(0, 16)}` };
    try {
      assertValid(program);
      programs.push(program);
    } catch (err) {
      refusals.push({ sequence, reason: `invalid program: ${(err as Error).message}` });
    }
  }

  const MAX_PROGRAMS = 24;
  const extra = programs.slice(MAX_PROGRAMS);
  for (const p of extra) refusals.push({ sequence: p.sequence ?? [], reason: "max programs cap" });
  return { programs: programs.slice(0, MAX_PROGRAMS), refusals };
}
