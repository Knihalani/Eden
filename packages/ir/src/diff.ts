import type { Binding, BindingKind, Step, StretchProgram } from "./types";
import { eq } from "./eq";

/**
 * A structured, human-reviewable summary of what changed between two
 * compilations of the same stretch.
 *
 * The drift canary re-mines stretches and queues new candidates that reference
 * old live versions. A reviewer approving such a candidate needs to see WHAT
 * CHANGED at a glance — not read two JSON blobs side by side. Everything in
 * here is computed from the IR itself, never from version-hash text: two
 * programs with different hashes but identical structure produce an empty
 * diff (hashes cover `contract.witnesses`, which grows on every re-mine).
 */
export type ProgramDiff = {
  /** Program display name changed. */
  name_changed: boolean;
  steps_added: { id: string; kind: Step["kind"]; tool?: string }[];
  steps_removed: { id: string }[];
  /**
   * Same step, same field, but the binding now resolves its value a different
   * way (`input` → `from`, say). Kind-to-kind moves only; value-level edits
   * inside one kind are not review flags on their own except for transforms,
   * where a rewritten expression is surfaced via `detail`.
   */
  bindings_changed: {
    step: string;
    field: string;
    from_kind: BindingKind;
    to_kind: BindingKind;
    detail?: string;
  }[];
  /**
   * The new program hardcodes a literal where the old one resolved a value
   * dynamically. A baked-in witness value is exactly what binding was invented
   * to avoid — every entry here is a review flag.
   */
  literals_introduced: { step: string; field: string }[];
  /**
   * Assert accounting. Tightened means "more or stricter checking": an assert
   * added, an expr rewritten, or onFail moving deopt → error (the run now dies
   * instead of deoptimising). Loosened is the mirror image: an assert dropped
   * or onFail error → deopt. An expr rewrite counts as tightened because a
   * changed check must be re-reviewed as if new.
   */
  asserts_tightened: number;
  asserts_loosened: number;
  contract_changed: boolean;
  /** What moved inside the contract, when contract_changed. */
  contract_changes: string[];
  /** Tool steps whose readOnlyHint-derived guarantee changed. Absent reads as "unknown". */
  readonly_flips: { step: string; from: boolean | "unknown"; to: boolean | "unknown" }[];
};

const EMPTY_DIFF: ProgramDiff = {
  name_changed: false,
  steps_added: [],
  steps_removed: [],
  bindings_changed: [],
  literals_introduced: [],
  asserts_tightened: 0,
  asserts_loosened: 0,
  contract_changed: false,
  contract_changes: [],
  readonly_flips: [],
};

function stepsOf(p: StretchProgram | null | undefined): Step[] {
  return Array.isArray(p?.steps) ? p!.steps : [];
}

/** Fields of a step that carry a Binding, keyed by reviewable field name. */
function boundFields(s: Step): [string, Binding][] {
  if (s.kind === "tool") return Object.entries(s.args ?? {});
  if (s.kind === "island") return [["input", s.input]];
  if (s.kind === "loop") return [["over", s.over]];
  return [];
}

const readOnlyOf = (s: Step): boolean | "unknown" => (s.kind === "tool" && s.readOnly !== undefined ? s.readOnly : "unknown");

function describeBinding(b: Binding): string {
  switch (b.kind) {
    case "literal":
      return "a hardcoded literal";
    case "input":
      return `run input ${b.path || "(root)"}`;
    case "from":
      return `step ${b.step}${b.path ? ` at ${b.path}` : ""}`;
    case "transform":
      return `${b.fn} over (${describeBinding(b.of)})`;
  }
}

function diffContract(oldC: StretchProgram["contract"], newC: StretchProgram["contract"]): string[] {
  const changes: string[] = [];
  if (!oldC || !newC) return changes;
  if (oldC.witnesses !== newC.witnesses) changes.push(`witnesses ${oldC.witnesses} -> ${newC.witnesses}`);
  if (oldC.minLlmReduction !== newC.minLlmReduction) changes.push(`minLlmReduction ${oldC.minLlmReduction} -> ${newC.minLlmReduction}`);
  if (oldC.allowExact !== newC.allowExact) changes.push(`allowExact ${oldC.allowExact} -> ${newC.allowExact}`);
  if (!eq(oldC.envelope ?? null, newC.envelope ?? null)) changes.push("envelope changed");
  return changes;
}

/**
 * Pure function over two programs. Never throws on partial IR: missing steps
 * read as empty, absent contracts produce no contract entries. Identical
 * programs (by value) yield the empty diff — including when only the version
 * hash or manifest differs, since neither is structure a reviewer votes on.
 */
export function diffPrograms(oldP: StretchProgram, newP: StretchProgram): ProgramDiff {
  const diff: ProgramDiff = {
    ...EMPTY_DIFF,
    steps_added: [],
    steps_removed: [],
    bindings_changed: [],
    literals_introduced: [],
    readonly_flips: [],
    contract_changes: [],
    name_changed: oldP?.name !== newP?.name,
  };

  const oldSteps = new Map<string, Step>();
  for (const s of stepsOf(oldP)) oldSteps.set(s.id, s);
  const newSteps = new Map<string, Step>();
  for (const s of stepsOf(newP)) newSteps.set(s.id, s);

  for (const [id, s] of newSteps) {
    if (oldSteps.has(id)) continue;
    diff.steps_added.push({ id, kind: s.kind, ...(s.kind === "tool" ? { tool: s.tool } : {}) });
    if (s.kind === "assert") diff.asserts_tightened++;
  }
  for (const [id, s] of oldSteps) {
    if (newSteps.has(id)) continue;
    diff.steps_removed.push({ id });
    if (s.kind === "assert") diff.asserts_loosened++;
  }

  for (const [id, next] of newSteps) {
    const prev = oldSteps.get(id);
    if (!prev) continue;

    // readOnly flips, before the kind guard: forcing a tool step into an
    // island drops readOnly entirely, and that regression deserves its own row.
    const roFrom = readOnlyOf(prev);
    const roTo = readOnlyOf(next);
    if (roFrom !== roTo) diff.readonly_flips.push({ step: id, from: roFrom, to: roTo });

    if (prev.kind !== next.kind) {
      // Same id, different step kind: show it as a remove+add pair so the
      // change cannot hide behind a half-matched binding comparison.
      diff.steps_removed.push({ id });
      diff.steps_added.push({ id, kind: next.kind, ...(next.kind === "tool" ? { tool: next.tool } : {}) });
      if (next.kind === "assert") diff.asserts_tightened++;
      if (prev.kind === "assert") diff.asserts_loosened++;
      continue;
    }
    if (prev.kind === "assert" && next.kind === "assert") {
      const exprChanged = prev.expr !== next.expr;
      const failChanged = prev.onFail !== next.onFail;
      if (failChanged) {
        if (prev.onFail === "deopt" && next.onFail === "error") diff.asserts_tightened++;
        else diff.asserts_loosened++;
      }
      if (exprChanged && !failChanged) diff.asserts_tightened++;
      continue;
    }
    const prevFields = new Map(boundFields(prev));
    for (const [field, to] of boundFields(next)) {
      const from = prevFields.get(field);
      if (!from) continue;
      recordBinding(id, field, from, to, diff);
    }
  }

  diff.contract_changes =
    oldP?.contract && newP?.contract ? diffContract(oldP.contract, newP.contract) : [];
  diff.contract_changed = diff.contract_changes.length > 0;
  return diff;
}

function recordBinding(step: string, field: string, from: Binding, to: Binding, diff: ProgramDiff): void {
  if (to.kind === "literal" && from.kind !== "literal") {
    diff.literals_introduced.push({ step, field });
    diff.bindings_changed.push({
      step,
      field,
      from_kind: from.kind,
      to_kind: to.kind,
      detail: `${describeBinding(from)} replaced by ${describeBinding(to)}`,
    });
    return;
  }
  if (from.kind !== to.kind) {
    diff.bindings_changed.push({
      step,
      field,
      from_kind: from.kind,
      to_kind: to.kind,
      detail: `${describeBinding(from)} -> ${describeBinding(to)}`,
    });
    return;
  }
  if (from.kind === "transform" && to.kind === "transform") {
    const fnChanged = from.fn !== to.fn;
    const exprChanged = from.expr !== to.expr;
    const ofChanged = !eq(from.of, to.of);
    if (fnChanged || exprChanged || ofChanged) {
      diff.bindings_changed.push({
        step,
        field,
        from_kind: "transform",
        to_kind: "transform",
        detail: fnChanged
          ? `transform ${from.fn} -> ${to.fn}`
          : exprChanged
            ? `expression rewritten: ${JSON.stringify(from.expr)} -> ${JSON.stringify(to.expr)}`
            : "source binding changed",
      });
    }
  }
}
