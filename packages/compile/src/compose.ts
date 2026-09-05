import type { Binding, Manifest, StretchProgram, StretchTrace, Step } from "@eden/ir";
import { eq, isMutating, withVersion } from "@eden/ir";
import { effectiveEventName } from "./mine";
import { assertHandoffNotLive } from "./handoff";

/**
 * Same-agent program composition (Wave 15.4).
 *
 * Distinct from Wave 7.3 handoff: that pass requires different `agentId`s and
 * `origin.mode: "handoff"`. This pass joins two already-compiled linear
 * programs when A.seq + B.seq appears on ≥ minSupport traces of the same
 * agent (or missing agentId). `manifest` stays null. Approve is the live
 * gate; `composedOf` is identity.
 *
 * Honesty: an unbound mutating join refuses — Eden will not guess.
 */

export type ComposePair = {
  a: StretchProgram;
  b: StretchProgram;
  traces: StretchTrace[];
  witnesses: number;
};

function okNames(t: StretchTrace): string[] {
  return t.events.filter((e) => e.ok && !e.skipped).map((e) => effectiveEventName(e));
}

function containsSeq(hay: string[], needle: string[]): boolean {
  if (!needle.length) return false;
  if (needle.length > hay.length) return false;
  const h = hay.join("\0");
  const n = needle.join("\0");
  return h === n || h.includes(`\0${n}\0`) || h.startsWith(`${n}\0`) || h.endsWith(`\0${n}`) || h === n;
}

function indexOfSeq(hay: string[], needle: string[]): number {
  if (!needle.length || needle.length > hay.length) return -1;
  for (let i = 0; i + needle.length <= hay.length; i++) {
    let ok = true;
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) {
        ok = false;
        break;
      }
    }
    if (ok) return i;
  }
  return -1;
}

const MIN_COMPOSE_CHILD = 3;

function isEligibleChild(p: StretchProgram): boolean {
  if (!p.id || p.id === "pending") return false;
  if (p.composedOf?.length) return false;
  if (p.origin?.mode === "handoff" || p.origin?.mode === "compose") return false;
  if (p.steps.some((s) => s.kind === "branch")) return false;
  return (p.sequence?.length ?? 0) >= 1;
}

/** Island/loop/branch stretches stay one program — do not split TicketShip, desk, ETL.
 *  A long linear provision (Helix 12-step launch) is also the product, not two
 *  midpoint children whose names are not world tools. */
function isRichStretch(p: StretchProgram): boolean {
  if (p.steps.some((s) => s.kind === "island" || s.kind === "loop" || s.kind === "branch")) return true;
  return (p.sequence?.length ?? 0) >= 10;
}

function seqKey(seq: string[]): string {
  return seq.join("\0");
}

export function matchProgramBySequence(programs: StretchProgram[], seq: string[]): StretchProgram | undefined {
  const key = seqKey(seq);
  return programs.find((p) => isEligibleChild(p) && seqKey(p.sequence ?? []) === key);
}

/**
 * Slice each trace to the contiguous block `seq` so a child can compile on
 * its own witnesses even when a longer n-gram also exists.
 */
export function sliceTracesToSeq(traces: StretchTrace[], seq: string[]): StretchTrace[] {
  const out: StretchTrace[] = [];
  for (const t of traces) {
    const ok = t.events.filter((e) => e.ok && !e.skipped);
    const names = ok.map((e) => effectiveEventName(e));
    const idx = indexOfSeq(names, seq);
    if (idx < 0) continue;
    const events = ok.slice(idx, idx + seq.length);
    const last = events.at(-1);
    out.push({
      ...t,
      id: `${t.id}::${seq.join(".")}`,
      events,
      llmCalls: Math.min(t.llmCalls, events.length) || events.length,
      output: last?.result ?? t.output,
    });
  }
  return out;
}

export type ComposeSplit = {
  aSeq: string[];
  bSeq: string[];
  traces: StretchTrace[];
  witnesses: number;
};

function mostBalancedSplit(seq: string[]): { aSeq: string[]; bSeq: string[] } | null {
  if (seq.length < MIN_COMPOSE_CHILD * 2) return null;
  const k = Math.floor(seq.length / 2);
  if (k < MIN_COMPOSE_CHILD || seq.length - k < MIN_COMPOSE_CHILD) return null;
  return { aSeq: seq.slice(0, k), bSeq: seq.slice(k) };
}

/**
 * Contiguous A.seq then B.seq blocks witnessed on ≥ minSupport traces, even
 * when linear clustering already compiled the concatenation as one program.
 *
 * Only plain linear programs are split. Island / loop / branch stretches
 * (TicketShip, desk, ETL) stay one program. A subsequence of a longer
 * compiled stretch is not a join.
 */
export function findWitnessedComposeSplits(
  traces: StretchTrace[],
  programs: StretchProgram[],
  minSupport: number,
): ComposeSplit[] {
  const out: ComposeSplit[] = [];
  const seen = new Set<string>();

  const consider = (seq: string[]) => {
    const split = mostBalancedSplit(seq);
    if (!split) return;
    const key = `${seqKey(split.aSeq)}|${seqKey(split.bSeq)}`;
    if (seen.has(key)) return;
    const join = [...split.aSeq, ...split.bSeq];
    const matching = traces.filter((t) => containsSeq(okNames(t), join));
    if (matching.length < minSupport) return;
    seen.add(key);
    out.push({ aSeq: split.aSeq, bSeq: split.bSeq, traces: matching, witnesses: matching.length });
  };

  for (const p of programs) {
    if (!isEligibleChild(p) || isRichStretch(p)) continue;
    consider(p.sequence ?? []);
  }

  return out;
}

function childIsMutating(p: StretchProgram): boolean {
  if ((p.sequence ?? []).some((n) => isMutating(n))) return true;
  return p.steps.some((s) => s.kind === "tool" && isMutating(s.tool));
}

/**
 * Pairs of already-compiled programs whose concatenated sequences appear on
 * ≥ minSupport same-agent traces. Fork programs and handoff parents are
 * never children. Either child lacking an id is skipped (no guessing).
 */
export function findComposeJoins(
  traces: StretchTrace[],
  programs: StretchProgram[],
  minSupport: number,
): ComposePair[] {
  const children = programs.filter(isEligibleChild);
  if (children.length < 2) return [];
  const out: ComposePair[] = [];
  const seen = new Set<string>();
  for (const a of children) {
    for (const b of children) {
      if (a.id === b.id) continue;
      const join = [...(a.sequence ?? []), ...(b.sequence ?? [])];
      if (join.length < 2) continue;
      const key = `${a.id}\0${b.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const matching = traces.filter((t) => containsSeq(okNames(t), join));
      if (matching.length < minSupport) continue;
      out.push({ a, b, traces: matching, witnesses: matching.length });
    }
  }
  return out;
}

function schemaKeys(schema: object): { properties: Record<string, { type: string }>; required: string[] } {
  const rec = schema as { properties?: Record<string, { type?: string }>; required?: string[] };
  const properties: Record<string, { type: string }> = {};
  for (const [k, v] of Object.entries(rec.properties ?? {})) {
    properties[k] = { type: v?.type === "number" ? "number" : v?.type === "boolean" ? "boolean" : "string" };
  }
  const required = [...(rec.required ?? Object.keys(properties))];
  return { properties, required };
}

function unionInputSchema(children: StretchProgram[]): StretchProgram["inputSchema"] {
  const properties: Record<string, { type: string }> = {};
  const required: string[] = [];
  for (const c of children) {
    const s = schemaKeys(c.inputSchema);
    for (const [k, v] of Object.entries(s.properties)) {
      if (!properties[k]) properties[k] = v;
    }
    for (const k of s.required) if (!required.includes(k)) required.push(k);
  }
  return { type: "object", properties, required };
}

function witnessedInputKeys(traces: StretchTrace[]): Set<string> {
  const keys = new Set<string>();
  for (const t of traces) {
    for (const k of Object.keys(t.input ?? {})) keys.add(k);
  }
  return keys;
}

function aLastResult(t: StretchTrace, aSeq: string[]): Record<string, unknown> | null {
  const ok = t.events.filter((e) => e.ok && !e.skipped);
  const names = ok.map((e) => effectiveEventName(e));
  const idx = indexOfSeq(names, aSeq);
  if (idx < 0) return null;
  const last = ok[idx + aSeq.length - 1];
  const r = last?.result;
  if (!r || typeof r !== "object" || Array.isArray(r)) return null;
  return r as Record<string, unknown>;
}

function lastResultHasKey(traces: StretchTrace[], aSeq: string[], key: string): boolean {
  if (!traces.length) return false;
  return traces.every((t) => {
    const r = aLastResult(t, aSeq);
    return !!r && key in r;
  });
}

function stepId(name: string, used: Set<string>): string {
  const base = name.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_|_$/g, "") || "prog";
  let id = base;
  let n = 2;
  while (used.has(id)) id = `${base}_${n++}`;
  used.add(id);
  return id;
}

function bPortionEvents(t: StretchTrace, aSeq: string[], bSeq: string[]): StretchTrace["events"] {
  const ok = t.events.filter((e) => e.ok && !e.skipped);
  const names = ok.map((e) => effectiveEventName(e));
  const idx = indexOfSeq(names, [...aSeq, ...bSeq]);
  if (idx < 0) {
    const bIdx = indexOfSeq(names, bSeq);
    if (bIdx < 0) return [];
    return ok.slice(bIdx, bIdx + bSeq.length);
  }
  return ok.slice(idx + aSeq.length, idx + aSeq.length + bSeq.length);
}

/**
 * Required keys of B as bound on the parent must match what the join traces
 * actually passed into B. Extra child-internal args (literals inside B) are
 * not the parent's to guess — only the identity the parent is binding.
 */
function requiredKeysHonest(
  traces: StretchTrace[],
  aSeq: string[],
  bSeq: string[],
  bArgs: Record<string, Binding>,
): boolean {
  if (!Object.keys(bArgs).length) return true;
  return traces.every((t) => {
    const aResult = aLastResult(t, aSeq) ?? {};
    const events = bPortionEvents(t, aSeq, bSeq);
    for (const [key, binding] of Object.entries(bArgs)) {
      const expected =
        binding.kind === "input"
          ? t.input?.[binding.path]
          : binding.kind === "from"
            ? aResult[binding.path]
            : undefined;
      for (const e of events) {
        if (!e.args || !(key in e.args)) continue;
        if (!eq(e.args[key], expected)) return false;
      }
    }
    return true;
  });
}

export type ComposeRefuse = {
  code: "underdetermined_write" | "no_envelope";
  reason: string;
  hint: string;
};

/**
 * Assemble a parent whose steps call child program names. `manifest` is null.
 * `composedOf` is child ids. Returns null when a required input was never
 * witnessed or a mutating join would require guessing.
 */
export function assembleComposeProgram(
  pair: ComposePair,
  opts: { minLlmReduction: number; allowExact: boolean },
): { program: StretchProgram; refuse?: undefined } | { program?: undefined; refuse: ComposeRefuse } {
  const { a, b, traces, witnesses } = pair;
  if (!a.id || !b.id || a.id === "pending" || b.id === "pending") {
    return {
      refuse: {
        code: "no_envelope",
        reason: "A composed join needs child program ids. Eden will not guess.",
        hint: "Compile each child stretch on its own witnesses first.",
      },
    };
  }
  const witnessed = witnessedInputKeys(traces);
  const used = new Set<string>();
  const steps: Step[] = [];
  const aSeq = a.sequence ?? [];
  const bSeq = b.sequence ?? [];

  const bindChild = (child: StretchProgram, prior: Step | undefined, forB: boolean): Record<string, Binding> | null => {
    const { required } = schemaKeys(child.inputSchema);
    const args: Record<string, Binding> = {};
    for (const key of required) {
      if (forB && prior && lastResultHasKey(traces, aSeq, key)) {
        args[key] = { kind: "from", step: prior.id, path: key };
      } else if (witnessed.has(key)) {
        args[key] = { kind: "input", path: key };
      } else {
        return null;
      }
    }
    return args;
  };

  const aArgs = bindChild(a, undefined, false);
  if (!aArgs) {
    return {
      refuse: {
        code: childIsMutating(a) ? "underdetermined_write" : "no_envelope",
        reason: "This join's first program needs inputs that were not witnessed. Eden will not guess.",
        hint: "Pass the child programs' arguments on the composed run's input.",
      },
    };
  }
  const aId = stepId(a.name, used);
  steps.push({ id: aId, kind: "tool", tool: a.name, args: aArgs });

  const bArgs = bindChild(b, steps[0], true);
  if (!bArgs) {
    return {
      refuse: {
        code: childIsMutating(b) ? "underdetermined_write" : "no_envelope",
        reason: "This join's second program needs inputs that were not witnessed. Eden will not guess.",
        hint: "Pass the child programs' arguments on the composed run's input, or bind them from the first program's result.",
      },
    };
  }
  if (childIsMutating(b) && !requiredKeysHonest(traces, aSeq, bSeq, bArgs)) {
    return {
      refuse: {
        code: "underdetermined_write",
        reason: "This join's mutating step cannot bind from the witnessed programs. Eden will not guess.",
        hint: "The write arguments on the joined traces do not match the first program's result or the composed input.",
      },
    };
  }
  const bId = stepId(b.name, used);
  steps.push({ id: bId, kind: "tool", tool: b.name, args: bArgs });

  const last = steps.at(-1);
  if (!last) {
    return {
      refuse: {
        code: "no_envelope",
        reason: "Compose produced no steps. Eden will not guess.",
        hint: "Both child programs must have bindable inputs.",
      },
    };
  }
  const env = a.contract.envelope;
  const schema = unionInputSchema([a, b]);
  const name = `${a.name}_then_${b.name}`.replace(/[^A-Za-z0-9_]+/g, "_").slice(0, 48) || "compose";
  return {
    program: withVersion({
      id: "pending",
      name,
      description: `Composed programs: ${a.name} → ${b.name}. Approve before this runs in front of the agent.`,
      inputSchema: schema,
      sequence: [a.name, b.name],
      steps,
      returns: { kind: "from", step: last.id, path: "" },
      contract: {
        witnesses,
        minLlmReduction: opts.minLlmReduction,
        allowExact: opts.allowExact,
        envelope: env,
      },
      manifest: null,
      origin: { mode: "compose" },
      composedOf: [a.id, b.id],
    }),
  };
}

/** Composed candidates are not live. `composedOf` does not fill `manifest`. */
export function assertComposeNotLive(p: StretchProgram): void {
  if (p.origin?.mode !== "compose" && p.origin?.mode !== "handoff" && !p.composedOf?.length) return;
  if (p.manifest != null) {
    throw new Error("composed program is not live until Approve: manifest must be null");
  }
  assertHandoffNotLive(p);
}

/**
 * Test-only stand-in for control Approve. Does not run in compile.
 * Reuses the handoff gate so compose is the same Approve contract.
 */
export function approveComposeInTest(p: StretchProgram, manifest: Manifest): StretchProgram {
  assertComposeNotLive(p);
  return { ...p, manifest };
}
