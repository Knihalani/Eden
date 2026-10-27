import type { Binding, Manifest, StretchProgram, StretchTrace, Step } from "@eden/ir";
import { withVersion } from "@eden/ir";
import { effectiveEventName } from "./mine";

/**
 * Handoff mining: detect repeated parent→child agent patterns and assemble a
 * composed program whose steps call already-compiled child programs by name.
 *
 * Linear clustering never sees this: each agent's stretch is its own sequence.
 * The runtime already lets a parent call a child via `composedRegistry`. This
 * pass is the compiler half — candidates only, `manifest` always null. Approve
 * is the live gate; `composedOf` is identity, not a ship switch.
 *
 * Three gates:
 *   1. Distinct `agentId`s in the group. Same-agent traces stay linear/fork.
 *   2. The ordered agent sequence appears on ≥ minSupport orchestrator runs.
 *   3. Every agent's stretch already compiled (or it refuses — no guessing).
 */

export type HandoffGroup = {
  /** Ordered agent ids for one orchestrator run (parent first when present). */
  agentOrder: string[];
  /** Unique agents in first-seen order — one child program / parent step each. */
  uniqueAgents: string[];
  tracesByAgent: Map<string, StretchTrace[]>;
  runs: StretchTrace[][];
  witnesses: number;
};

function okNames(t: StretchTrace): string[] {
  return t.events.filter((e) => e.ok && !e.skipped).map((e) => effectiveEventName(e));
}

function uniqueOrder(ids: string[]): string[] {
  const out: string[] = [];
  for (const id of ids) if (!out.includes(id)) out.push(id);
  return out;
}

function containsSeq(hay: string[], needle: string[]): boolean {
  if (!needle.length) return false;
  if (needle.length > hay.length) return false;
  const h = hay.join("\0");
  const n = needle.join("\0");
  return h === n || h.includes(n);
}

/**
 * Group traces into orchestrator runs.
 *
 * Children carry `parentRunId` equal to the parent stretch id, or all siblings
 * of one run share a `parentRunId` when the parent stretch is absent.
 */
export function findHandoffGroups(traces: StretchTrace[], minSupport: number): HandoffGroup[] {
  const byId = new Map<string, StretchTrace>();
  for (const t of traces) byId.set(t.id, t);

  const childrenByParent = new Map<string, StretchTrace[]>();
  for (const t of traces) {
    if (!t.parentRunId) continue;
    const list = childrenByParent.get(t.parentRunId);
    if (list) list.push(t);
    else childrenByParent.set(t.parentRunId, [t]);
  }

  const runs: StretchTrace[][] = [];
  for (const [parentKey, children] of childrenByParent) {
    const parent = byId.get(parentKey);
    const members: StretchTrace[] = [];
    if (parent) members.push(parent);
    for (const c of children) members.push(c);
    if (members.length < 2) continue;
    if (!members.every((t) => typeof t.agentId === "string" && t.agentId.length > 0)) continue;
    const agents = uniqueOrder(members.map((t) => t.agentId!));
    // Handoff only when agentId differs. Single-agent traces stay linear/fork.
    if (agents.length < 2) continue;
    runs.push(members);
  }

  const bySeq = new Map<string, StretchTrace[][]>();
  for (const members of runs) {
    const order = members.map((t) => t.agentId!);
    const key = order.join("\0");
    const list = bySeq.get(key);
    if (list) list.push(members);
    else bySeq.set(key, [members]);
  }

  const out: HandoffGroup[] = [];
  for (const [key, groupRuns] of bySeq) {
    if (groupRuns.length < minSupport) continue;
    const agentOrder = key.split("\0");
    const uniqueAgents = uniqueOrder(agentOrder);
    if (uniqueAgents.length < 2) continue;
    const tracesByAgent = new Map<string, StretchTrace[]>();
    for (const members of groupRuns) {
      for (const t of members) {
        const a = t.agentId!;
        const list = tracesByAgent.get(a);
        if (list) list.push(t);
        else tracesByAgent.set(a, [t]);
      }
    }
    out.push({
      agentOrder,
      uniqueAgents,
      tracesByAgent,
      runs: groupRuns,
      witnesses: groupRuns.length,
    });
  }
  return out;
}

/**
 * The linear (non-fork, non-handoff) program whose sequence this agent's
 * traces actually ran. Missing means that agent's stretch refused — the
 * handoff refuses with it rather than inventing a child.
 */
export function matchChildProgram(programs: StretchProgram[], agentTraces: StretchTrace[]): StretchProgram | undefined {
  if (!agentTraces.length) return undefined;
  let best: StretchProgram | undefined;
  for (const p of programs) {
    if (p.composedOf?.length) continue;
    if (p.origin?.mode === "handoff") continue;
    if (p.steps.some((s) => s.kind === "branch")) continue;
    const seq = p.sequence ?? [];
    if (!seq.length) continue;
    const hits = agentTraces.filter((t) => containsSeq(okNames(t), seq)).length;
    if (hits < agentTraces.length) continue;
    if (!best || seq.length > (best.sequence?.length ?? 0)) best = p;
  }
  return best;
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

function lastResultHasKey(traces: StretchTrace[], key: string): boolean {
  if (!traces.length) return false;
  return traces.every((t) => {
    const last = [...t.events].reverse().find((e) => e.ok && !e.skipped);
    const r = last?.result;
    return !!r && typeof r === "object" && !Array.isArray(r) && key in (r as object);
  });
}

function witnessedInputKeys(group: HandoffGroup): Set<string> {
  const keys = new Set<string>();
  for (const traces of group.tracesByAgent.values()) {
    for (const t of traces) {
      for (const k of Object.keys(t.input ?? {})) keys.add(k);
    }
  }
  return keys;
}

function stepId(name: string, used: Set<string>): string {
  const base = name.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_|_$/g, "") || "agent";
  let id = base;
  let n = 2;
  while (used.has(id)) id = `${base}_${n++}`;
  used.add(id);
  return id;
}

/**
 * Assemble a parent whose steps are `kind:"tool"` targeting child program
 * names. `manifest` is null. `composedOf` is child ids. Returns null when a
 * child's required input was never witnessed — fail closed, do not guess.
 */
export function assembleHandoffProgram(
  group: HandoffGroup,
  children: StretchProgram[],
  opts: { minLlmReduction: number; allowExact: boolean },
): StretchProgram | null {
  if (children.length < 2) return null;
  if (children.length !== group.uniqueAgents.length) return null;
  const witnessed = witnessedInputKeys(group);
  const used = new Set<string>();
  const steps: Step[] = [];
  const names: string[] = [];
  for (let i = 0; i < children.length; i++) {
    const child = children[i]!;
    const { required } = schemaKeys(child.inputSchema);
    const args: Record<string, Binding> = {};
    const prior = steps.at(-1);
    const prevAgent = i > 0 ? group.uniqueAgents[i - 1] : undefined;
    const prevTraces = prevAgent ? (group.tracesByAgent.get(prevAgent) ?? []) : [];
    for (const key of required) {
      if (prior && lastResultHasKey(prevTraces, key)) {
        args[key] = { kind: "from", step: prior.id, path: key };
      } else if (witnessed.has(key)) {
        args[key] = { kind: "input", path: key };
      } else {
        return null;
      }
    }
    // A handoff is ordered (intake then specialist). Independent input
    // bindings would let the runtime wave the children in parallel.
    if (prior && !Object.values(args).some((b) => b.kind === "from")) {
      return null;
    }
    const id = stepId(child.name, used);
    steps.push({ id, kind: "tool", tool: child.name, args });
    names.push(child.name);
  }
  const last = steps.at(-1);
  if (!last) return null;
  const intake = children[0]!;
  const env = intake.contract.envelope;
  const schema = unionInputSchema(children);
  const first = group.uniqueAgents[0] ?? "agent";
  const lastAgent = group.uniqueAgents.at(-1) ?? "agent";
  const name = `${first}_to_${lastAgent}`.replace(/[^A-Za-z0-9_]+/g, "_").slice(0, 48) || "handoff";
  return withVersion({
    id: "pending",
    name,
    description: `Composed handoff: ${names.join(" → ")}. Approve before this runs in front of the agent.`,
    inputSchema: schema,
    sequence: names,
    steps,
    returns: { kind: "from", step: last.id, path: "" },
    contract: {
      witnesses: group.witnesses,
      minLlmReduction: opts.minLlmReduction,
      allowExact: opts.allowExact,
      envelope: env,
    },
    manifest: null,
    origin: { mode: "handoff" },
    composedOf: children.map((c) => c.id),
  });
}

/** Composed candidates are not live. `composedOf` does not fill `manifest`. */
export function assertHandoffNotLive(p: StretchProgram): void {
  if (p.origin?.mode !== "handoff" && !p.composedOf?.length) return;
  if (p.manifest != null) {
    throw new Error("composed handoff is not live until Approve: manifest must be null");
  }
}

/**
 * Test-only stand-in for control Approve: sets `manifest` the way a successful
 * ship does. Does not run in compile. The original program is unchanged.
 */
export function approveInTest(p: StretchProgram, manifest: Manifest): StretchProgram {
  assertHandoffNotLive(p);
  return { ...p, manifest };
}
