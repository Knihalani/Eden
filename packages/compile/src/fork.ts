import type { Binding, StretchProgram, Step, StretchTrace } from "@eden/ir";
import { isMutating, isShellCommand } from "@eden/ir";
import { argKeys, bindSlotWitnesses, remapBinding } from "./bind";

/**
 * Fork mining: detect where witnesses share a prefix then split into
 * arms, and synthesize the guard predicate from logged data attributes.
 *
 * This is the compiler's answer to conditional workflows: an agent that
 * checks CI then either fixes or notifies has two linear suffixes after one
 * shared prefix. Three witnessed arms compile to one n-way branch (then +
 * cases + else), not nested binary else-of-else. The n-gram clusterer sees
 * unrelated clusters; this pass sees one workflow with a branch.
 *
 * Three gates (plan §6):
 *   1. Each arm needs ≥ minSupport witnesses.
 *   2. A result field of the LAST prefix step must cleanly separate the
 *      populations — every arm's witnesses carry a distinct value. Without a
 *      clean separator the stretch refuses.
 *   3. The emitted expr uses only equality against witnessed values; no
 *      free-form predicates.
 */

/** Why `assembleForkProgram` returned null — compile.ts stamps this code. */
export interface ForkRefuse {
  code: "underdetermined_write" | "unbound_branch";
  reason: string;
  hint: string;
  slot?: string;
}

export interface ForkArm {
  value: string;
  suffix: string[];
  traces: StretchTrace[];
}

export interface ForkCandidate {
  /** Shared event-name prefix before the divergence point. */
  prefixNames: string[];
  /** Arm A: name suffix + member traces. */
  thenSuffix: string[];
  thenTraces: StretchTrace[];
  /** Arm B: name suffix + member traces. */
  elseSuffix: string[];
  elseTraces: StretchTrace[];
  /** The discriminating field on the last prefix event's result. */
  field: string;
  /** Value that selects the THEN arm. */
  thenValue: string;
  /**
   * Extra arms beyond binary. Absent for two-arm forks so existing CI-gate
   * tests stay one candidate / one branch / no cases. Assemble emits these as
   * `cases` on a single n-way BranchStep (first matching expr wins, then else).
   */
  nestedArms?: ForkArm[];
  /** Set when assembleForkProgram returns null, so the fork pass can name the class. */
  assembleRefuse?: ForkRefuse;
}

/** Deduped traces covering every arm of a (possibly n-way) fork. */
export function forkWitnessTraces(c: ForkCandidate): StretchTrace[] {
  const seen = new Set<string>();
  const out: StretchTrace[] = [];
  for (const t of [...c.thenTraces, ...c.elseTraces, ...(c.nestedArms ?? []).flatMap((a) => a.traces)]) {
    if (seen.has(t.id)) continue;
    seen.add(t.id);
    out.push(t);
  }
  return out;
}

/** Tokenize a command into whitespace-separated words for shape comparison. */
function cmdTokens(cmd: string): string[] {
  return cmd.trim().split(/\s+/);
}

/** Canonical JSON of a result value for equality comparison. */
function fingerprint(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export function findForkedGroups(traces: StretchTrace[], minSupport: number): ForkCandidate[] {
  // Group traces by their full event-name signature to find cohorts.
  const bySig = new Map<string, StretchTrace[]>();
  for (const t of traces) {
    if (!t.events.length) continue;
    const sig = t.events.map((e) => e.name).join("\0");
    const list = bySig.get(sig);
    if (list) list.push(t);
    else bySig.set(sig, [t]);
  }

  const sigs = [...bySig.keys()];
  const candidates: ForkCandidate[] = [];

  // Compare every pair of cohort signatures for a shared-prefix + divergent-tail
  // pattern. With N cohorts this is O(N²) pairwise comparisons, but N is
  // small (<20 per workspace in practice).
  for (let i = 0; i < sigs.length; i++) {
    for (let j = i + 1; j < sigs.length; j++) {
      const a = sigs[i]!.split("\0");
      const b = sigs[j]!.split("\0");
      const groupA = bySig.get(sigs[i]!)!;
      const groupB = bySig.get(sigs[j]!)!;
      if (groupA.length < minSupport || groupB.length < minSupport) continue;

      // Find longest common name prefix.
      let cp = 0;
      while (cp < a.length && cp < b.length && a[cp] === b[cp]) cp++;
      // A single shared check step before the fork is enough — checking CI
      // then splitting into fix/notify is the canonical pattern.
      if (cp < 1) continue;

      // Both must have events AFTER the shared prefix (the divergence).
      if (a.length <= cp || b.length <= cp) continue;

      // Exactly two arms: each cohort continues with its own steps.
      const thenSuffix = a.slice(cp);
      const elseSuffix = b.slice(cp);
      if (!thenSuffix.length || !elseSuffix.length) continue;
      if (thenSuffix.join("\0") === elseSuffix.join("\0")) continue; // same suffix, different length

      // Predicate synthesis: find a result field of the LAST shared prefix
      // event whose value cleanly separates the populations.
      const lastPrefixIdx = cp - 1;
      const lastA = groupA[0]?.events[lastPrefixIdx];
      const lastB = groupB[0]?.events[lastPrefixIdx];
      if (!lastA?.result || typeof lastA.result !== "object" || !lastB?.result || typeof lastB.result !== "object")
        continue;

      const recA = lastA.result as Record<string, unknown>;
      const recB = lastB.result as Record<string, unknown>;
      let field: string | null = null;
      let valA: string | null = null;
      let valB: string | null = null;

      for (const key of Object.keys(recA)) {
        const va = recA[key];
        const vb = recB[key];
        if (va === undefined || vb === undefined) continue;
        const sa = String(va);
        const sb = String(vb);
        if (sa === sb) continue;
        // Verify the separation holds across ALL members of both cohorts.
        const allA = groupA.every((t) => {
          const r = t.events[lastPrefixIdx]?.result as Record<string, unknown> | undefined;
          return r && String(r[key]) === sa;
        });
        const allB = groupB.every((t) => {
          const r = t.events[lastPrefixIdx]?.result as Record<string, unknown> | undefined;
          return r && String(r[key]) === sb;
        });
        if (allA && allB) {
          field = key;
          valA = sa;
          valB = sb;
          break;
        }
      }
      if (!field) continue;

      candidates.push({
        prefixNames: a.slice(0, cp),
        thenSuffix,
        thenTraces: groupA,
        elseSuffix,
        elseTraces: groupB,
        field,
        thenValue: valA!,
      });
    }
  }
  return mergeSharedPrefixForks(candidates);
}

/**
 * Pairwise mining yields n(n-1)/2 candidates for n arms on the same
 * prefix+field. Collapse those into one n-way fork so Needs attention is
 * one method, not three pairwise gates.
 */
function mergeSharedPrefixForks(candidates: ForkCandidate[]): ForkCandidate[] {
  if (candidates.length <= 1) return candidates;
  const groups = new Map<string, ForkCandidate[]>();
  for (const c of candidates) {
    const k = `${c.prefixNames.join("\0")}\0\0${c.field}`;
    const list = groups.get(k);
    if (list) list.push(c);
    else groups.set(k, [c]);
  }
  const out: ForkCandidate[] = [];
  for (const group of groups.values()) {
    if (group.length === 1) {
      out.push(group[0]!);
      continue;
    }
    const arms = new Map<string, ForkArm>();
    const add = (value: string, suffix: string[], traces: StretchTrace[]) => {
      if (!arms.has(value)) arms.set(value, { value, suffix, traces });
    };
    for (const c of group) {
      add(c.thenValue, c.thenSuffix, c.thenTraces);
      const elseVal = armFieldValue(c.elseTraces, c.prefixNames.length - 1, c.field);
      if (elseVal != null) add(elseVal, c.elseSuffix, c.elseTraces);
    }
    const list = [...arms.values()];
    if (list.length < 2) {
      out.push(group[0]!);
      continue;
    }
    const head = list[0]!;
    const rest = list.slice(1);
    out.push({
      prefixNames: group[0]!.prefixNames,
      field: group[0]!.field,
      thenSuffix: head.suffix,
      thenTraces: head.traces,
      thenValue: head.value,
      elseSuffix: rest[0]!.suffix,
      elseTraces: rest[0]!.traces,
      nestedArms: rest.length >= 2 ? rest : undefined,
    });
  }
  return out;
}

function armFieldValue(traces: StretchTrace[], prefixIdx: number, field: string): string | null {
  const r = traces[0]?.events[prefixIdx]?.result;
  if (!r || typeof r !== "object" || Array.isArray(r)) return null;
  const v = (r as Record<string, unknown>)[field];
  if (v === undefined) return null;
  return String(v);
}

function unboundBranchRefuse(slot?: string): ForkRefuse {
  return {
    code: "unbound_branch",
    reason:
      "This workflow branches, but some step's arguments could not be bound from the recorded witnesses. Eden refuses to guess.",
    hint: "Bind every branch arm from recorded witnesses. Eden will not guess.",
    slot,
  };
}

function underdeterminedWriteRefuse(tool: string, key?: string): ForkRefuse {
  const slot = key ? `${tool}.${key}` : tool;
  return {
    code: "underdetermined_write",
    reason: key ? `${tool}.${key}: under-determined mutating argument` : `${tool} mutating call has no bound arguments`,
    hint: key
      ? `${tool}.${key} could not be bound from input or a prior step. Name the path — Eden will not guess.`
      : `${tool} is a write with no bound arguments. Pass IDs or payloads from input or a prior step.`,
    slot,
  };
}

/**
 * Assemble an executable branched program from a fork candidate.
 *
 * Builds prefix tool steps from shared witnesses, then per-arm tool steps
 * with bindings from each arm's own traces, connected via a BranchStep whose
 * predicate is the synthesized guard (`field == "thenValue"`).
 *
 * Returns null when any step's arguments cannot be bound — honesty over
 * guessing. A mutating arm that cannot bind sets `candidate.assembleRefuse`
 * to `underdetermined_write` so compile.ts stamps the same code as linear.
 */
export function assembleForkProgram(candidate: ForkCandidate, programId: string, name: string): StretchProgram | null {
  const { prefixNames, thenSuffix, thenTraces, elseSuffix, elseTraces, field, thenValue } = candidate;
  candidate.assembleRefuse = undefined;
  const fail = (refuse: ForkRefuse): null => {
    candidate.assembleRefuse = refuse;
    return null;
  };
  // Predicate safety: the expr is interpolated into the assert grammar, so a
  // field that is not a plain identifier path or a value carrying quotes or
  // escapes would produce a program that cannot tokenize (or worse, tokenizes
  // into something never witnessed). Refuse at compile time — honesty over
  // guessing.
  if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(field)) return fail(unboundBranchRefuse(field));
  if (!/^[^"\\\r\n]*$/.test(thenValue)) return fail(unboundBranchRefuse(field));
  for (const arm of candidate.nestedArms ?? []) {
    if (!/^[^"\\\r\n]*$/.test(arm.value)) return fail(unboundBranchRefuse(field));
  }
  const used = new Set<string>();
  const steps: Step[] = [];
  const inputPaths = new Set<string>();
  const nameToId = new Map<string, string>();
  const cp = prefixNames.length;
  const allTraces = forkWitnessTraces(candidate);

  const buildArmOrPrefix = (
    suffixNames: string[],
    traces: StretchTrace[],
    startOffset: number,
    priorNames: string[],
  ): { ids: string[]; ok: boolean; refuse?: ForkRefuse } => {
    const ids: string[] = [];
    const localMap = new Map(nameToId);
    for (let pos = 0; pos < suffixNames.length; pos++) {
      const eventName = suffixNames[pos]!;
      const evIdx = startOffset + pos;
      const alignedEvents = traces.map((t) => t.events[evIdx]).filter((e): e is NonNullable<typeof e> => !!e && e.ok);
      if (!alignedEvents.length || alignedEvents.length < traces.length) {
        return { ids, ok: false, refuse: unboundBranchRefuse(eventName) };
      }

      const realTool = alignedEvents[0]!.name;
      const sid = `${eventName.replace(/[^A-Za-z0-9]/g, "_")}_${used.size}`;
      if (used.has(sid)) continue;
      used.add(sid);

      const args: Record<string, Binding> = {};
      const keys = argKeys(alignedEvents);
      const priorIds = [...priorNames, ...suffixNames.slice(0, pos)];
      let failKey: string | undefined;
      for (const key of keys) {
        const vals = alignedEvents.map((ev) => (ev.args as Record<string, unknown>)?.[key]);
        const bound = bindSlotWitnesses(vals, traces, priorIds, {
          mutating: isMutating(realTool),
          allowExact: false,
          shell: isShellCommand(realTool, key),
        });
        if (!bound.ok) {
          failKey = key;
          break;
        }
        args[key] = remapBinding(bound.binding, localMap);
        if (bound.binding.kind === "input" && bound.binding.path) inputPaths.add(bound.binding.path);
      }
      if (failKey !== undefined) {
        return {
          ids,
          ok: false,
          refuse: isMutating(realTool)
            ? underdeterminedWriteRefuse(realTool, failKey)
            : unboundBranchRefuse(`${realTool}.${failKey}`),
        };
      }
      if (isMutating(realTool) && !Object.keys(args).length) {
        return { ids, ok: false, refuse: underdeterminedWriteRefuse(realTool) };
      }
      steps.push({ id: sid, kind: "tool", tool: realTool, args });
      ids.push(sid);
      localMap.set(eventName, sid);
      nameToId.set(eventName, sid);
    }
    return { ids, ok: true };
  };

  const prefixResult = buildArmOrPrefix(prefixNames, allTraces, 0, []);
  if (!prefixResult.ok && prefixNames.length > 0) return fail(prefixResult.refuse ?? unboundBranchRefuse());

  type Arm = { value: string; suffix: string[]; traces: StretchTrace[] };
  const arms: Arm[] = [
    { value: thenValue, suffix: thenSuffix, traces: thenTraces },
    ...(candidate.nestedArms ?? [{ value: "", suffix: elseSuffix, traces: elseTraces }]),
  ];

  const built: Array<{ value: string; ids: string[] }> = [];
  for (const arm of arms) {
    const r = buildArmOrPrefix(arm.suffix, arm.traces, cp, prefixNames);
    if (!r.ok || !r.ids.length) return fail(r.refuse ?? unboundBranchRefuse());
    built.push({ value: arm.value, ids: r.ids });
  }
  if (!built.length) return fail(unboundBranchRefuse());

  const head = built[0]!;
  const elseIds = built.length === 1 ? [] : built[built.length - 1]!.ids;
  const extras = built.slice(1, -1);
  // ≥3 arms → one branch with cases. Two-arm CI-gate stays expr/then/else, no cases.
  const cases =
    extras.length === 0 ? undefined : extras.map((a) => ({ expr: `${field} == "${a.value}"`, steps: a.ids }));

  let branchId = `branch_${field}`;
  let n = 2;
  while (used.has(branchId)) branchId = `branch_${field}_${n++}`;
  used.add(branchId);
  steps.push({
    id: branchId,
    kind: "branch",
    expr: `${field} == "${head.value}"`,
    then: head.ids,
    else: elseIds,
    ...(cases ? { cases } : {}),
  });

  // Program-level envelope from combined inputs.
  const envInputs: Record<string, unknown[]> = {};
  for (const path of inputPaths) {
    const seen = new Set<string>();
    const vals: unknown[] = [];
    for (const t of allTraces) {
      const v = (t.input as Record<string, unknown>)?.[path];
      if (v !== undefined) {
        const k = fingerprint(v);
        if (!seen.has(k)) {
          seen.add(k);
          vals.push(v);
        }
      }
    }
    if (vals.length) envInputs[path] = vals;
  }

  const lastThenStep = head.ids.at(-1);
  // The branch step itself stores the executed arm's last value in the scope
  // (execute.ts writes scope.results.set(branchId, armValue) whichever arm
  // ran), so binding `returns` to the BRANCH — not to one arm's last step —
  // is what makes both arms return their own result. The previous
  // then-preferred binding threw "unknown step" on every else-arm run.
  void lastThenStep;

  const propEntries = [...inputPaths].map((k) => {
    const sample = allTraces.find((t) => (t.input as Record<string, unknown> | undefined)?.[k] !== undefined)?.input as
      Record<string, unknown> | undefined;
    const val = sample?.[k];
    const t = typeof val === "number" ? "number" : typeof val === "boolean" ? "boolean" : "string";
    return [k, { type: t }];
  });

  return {
    id: programId,
    version: "1",
    name,
    description: `Branched workflow: ${prefixNames.join(" → ")} then ${field} gate.`,
    inputSchema: { type: "object", properties: Object.fromEntries(propEntries), required: [...inputPaths] },
    sequence: [...prefixNames, `branch_${field}`],
    steps,
    returns: { kind: "from", step: branchId, path: "" },
    contract: {
      witnesses: allTraces.length,
      minLlmReduction: 2,
      // The envelope lives INSIDE the contract — inDistribution() reads only
      // program.contract.envelope. A top-level key was invisible to it, so
      // every input looked out-of-distribution and every fork program deopted.
      // A program with ZERO bound inputs is fully literal: nothing variable
      // exists to be out-of-distribution, so exact replay is always safe.
      allowExact: inputPaths.size === 0,
      envelope: Object.keys(envInputs).length ? { inputs: envInputs } : undefined,
    },
    manifest: null,
  } as unknown as StretchProgram;
}
