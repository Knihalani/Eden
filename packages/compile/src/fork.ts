import type { Binding, BranchStep, StretchProgram, Step, StretchTrace } from "@eden/ir";
import { isMutating } from "@eden/ir";
import { effectiveEventName } from "./mine";

/**
 * Fork mining: detect where witnesses share a prefix then split into two
 * arms, and synthesize the guard predicate from logged data attributes.
 *
 * This is the compiler's answer to conditional workflows: an agent that
 * checks CI then either fixes or notifies has two linear suffixes after one
 * shared prefix. The n-gram clusterer sees three unrelated clusters; this
 * pass sees one workflow with a branch.
 *
 * Three gates (plan §6):
 *   1. Both arms need ≥ minSupport witnesses.
 *   2. A result field of the LAST prefix step must cleanly separate the
 *      populations — every arm-A witness carries value vA, every arm-B
 *      witness vB ≠ vA. Without a clean separator the stretch refuses.
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
  /** Set when assembleForkProgram returns null, so the fork pass can name the class. */
  assembleRefuse?: ForkRefuse;
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

export function findForkedGroups(
  traces: StretchTrace[],
  minSupport: number,
): ForkCandidate[] {
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
      if (!lastA?.result || typeof lastA.result !== "object" || !lastB?.result || typeof lastB.result !== "object") continue;

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
  return candidates;
}

function unboundBranchRefuse(slot?: string): ForkRefuse {
  return {
    code: "unbound_branch",
    reason: "This workflow branches, but some step's arguments could not be bound from the recorded witnesses. Eden refuses to guess.",
    hint: "Bind every branch arm from recorded witnesses. Eden will not guess.",
    slot,
  };
}

function underdeterminedWriteRefuse(tool: string, key?: string): ForkRefuse {
  const slot = key ? `${tool}.${key}` : tool;
  return {
    code: "underdetermined_write",
    reason: key
      ? `${tool}.${key}: under-determined mutating argument`
      : `${tool} mutating call has no bound arguments`,
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
export function assembleForkProgram(
  candidate: ForkCandidate,
  programId: string,
  name: string,
): StretchProgram | null {
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
  const used = new Set<string>();
  const steps: Step[] = [];
  const inputPaths = new Set<string>();
  const cp = prefixNames.length;

  const buildArmOrPrefix = (
    suffixNames: string[],
    traces: StretchTrace[],
    startOffset: number,
    isShared: boolean,
  ): { ids: string[]; ok: boolean; refuse?: ForkRefuse } => {
    const ids: string[] = [];
    for (let pos = 0; pos < suffixNames.length; pos++) {
      const eventName = suffixNames[pos]!;
      const evIdx = startOffset + pos;
      // Align across this group's traces.
      const alignedEvents = traces
        .map((t) => t.events[evIdx])
        .filter((e): e is NonNullable<typeof e> => !!e && e.ok);
      if (!alignedEvents.length || alignedEvents.length < traces.length) {
        return { ids, ok: false, refuse: unboundBranchRefuse(eventName) };
      }

      const realTool = alignedEvents[0]!.name;
      const sid = `${eventName.replace(/[^A-Za-z0-9]/g, "_")}_${used.size}`;
      if (used.has(sid)) continue;
      used.add(sid);

      const args: Record<string, Binding> = {};
      const argKeysSet = new Set<string>();
      for (const ev of alignedEvents) {
        for (const k of Object.keys(ev.args ?? {})) argKeysSet.add(k);
      }

      let failKey: string | undefined;
      for (const key of argKeysSet) {
        const vals = alignedEvents.map((ev) => (ev.args as Record<string, unknown>)?.[key]);
        // Check if constant → literal.
        const fp0 = fingerprint(vals[0]);
        if (vals.every((v) => fingerprint(v) === fp0)) {
          args[key] = { kind: "literal", value: vals[0] };
          continue;
        }
        // Try input binding: key maps to input path ik when EVERY witness's
        // arg equals ITS OWN input value at that path. The previous loop held
        // one witness's value constant across all of them, which only ever
        // matched cohorts sharing a single input — so varying inputs (the
        // entire point of compilation) failed to bind and the fork refused.
        let bound = false;
        const inputPathsOfFirst = Object.keys(traces[0]?.input ?? {});
        for (const ik of inputPathsOfFirst) {
          const matches = vals.every((v, j) => {
            const iv = (traces[j]?.input as Record<string, unknown> | undefined)?.[ik];
            if (iv === undefined) return false;
            return String(v) === String(iv) || JSON.stringify(v) === JSON.stringify(iv);
          });
          if (matches) {
            args[key] = { kind: "input", path: ik };
            inputPaths.add(ik);
            bound = true;
            break;
          }
        }
        if (!bound) {
          failKey = key;
          break;
        }
      }
      if (failKey !== undefined) {
        return {
          ids,
          ok: false,
          refuse: isMutating(realTool) ? underdeterminedWriteRefuse(realTool, failKey) : unboundBranchRefuse(`${realTool}.${failKey}`),
        };
      }
      if (isMutating(realTool) && !Object.keys(args).length) {
        return { ids, ok: false, refuse: underdeterminedWriteRefuse(realTool) };
      }
      steps.push({ id: sid, kind: "tool", tool: realTool, args });
      ids.push(sid);
    }
    return { ids, ok: true };
  };

  // Build shared prefix steps (from ALL traces).
  const allTraces = [...thenTraces, ...elseTraces];
  const prefixResult = buildArmOrPrefix(prefixNames, allTraces, 0, true);
  if (!prefixResult.ok && prefixNames.length > 0) return fail(prefixResult.refuse ?? unboundBranchRefuse());

  // Build then-arm steps.
  const thenStart = cp;
  const thenResult = buildArmOrPrefix(thenSuffix, thenTraces, thenStart, false);
  if (!thenResult.ok || !thenResult.ids.length) return fail(thenResult.refuse ?? unboundBranchRefuse());

  // Build else-arm steps.
  const elseStart = cp;
  const elseResult = buildArmOrPrefix(elseSuffix, elseTraces, elseStart, false);
  if (!elseResult.ok || !elseResult.ids.length) return fail(elseResult.refuse ?? unboundBranchRefuse());

  // Create BranchStep.
  const branchId = `branch_${field}`;
  used.add(branchId);

  steps.push({
    id: branchId,
    kind: "branch",
    expr: `${field} == "${thenValue}"`,
    then: thenResult.ids,
    else: elseResult.ids,
  } as unknown as Step);

  // Program-level envelope from combined inputs.
  const envInputs: Record<string, unknown[]> = {};
  for (const path of inputPaths) {
    const seen = new Set<string>();
    const vals: unknown[] = [];
    for (const t of allTraces) {
      const v = (t.input as Record<string, unknown>)?.[path];
      if (v !== undefined) {
        const k = fingerprint(v);
        if (!seen.has(k)) { seen.add(k); vals.push(v); }
      }
    }
    if (vals.length) envInputs[path] = vals;
  }

  const lastThenStep = thenResult.ids.at(-1);
  const lastElseStep = elseResult.ids.at(-1);
  // The branch step itself stores the executed arm's last value in the scope
  // (execute.ts writes scope.results.set(branchId, armValue) whichever arm
  // ran), so binding `returns` to the BRANCH — not to one arm's last step —
  // is what makes both arms return their own result. The previous
  // then-preferred binding threw "unknown step" on every else-arm run.
  void lastThenStep;
  void lastElseStep;

  // Input schema types mirror the linear path: derive from a witnessed sample.
  const allTracesForType = [...thenTraces, ...elseTraces];
  const propEntries = [...inputPaths].map((k) => {
    const sample =
      (thenTraces[0]?.input as Record<string, unknown> | undefined)?.[k] ??
      (elseTraces[0]?.input as Record<string, unknown> | undefined)?.[k];
    const t = typeof sample === "number" ? "number" : typeof sample === "boolean" ? "boolean" : "string";
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
      witnesses: thenTraces.length + elseTraces.length,
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
